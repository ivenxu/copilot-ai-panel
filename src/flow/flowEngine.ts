/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IFlowConfig, ISkillRef, IAgentRef, IContextRef, IPromptRef, IRoleResponse, FlowService } from './flowService';
import { FlowContextBuilder, IFlowContext } from '../context/flowContextBuilder';
import { FlowTurn, FlowConversationStore } from '../session/flowConversation';
import { ContextFile, FlowPromptRenderer, BLOCKED_TOOLS } from '../prompts/flowPromptRenderer';
import { ToolCallRound } from '../prompts/flowTools';
import { normalizeToolSchemas } from '../util/toolSchemaNormalizer';
import { filterTools, shouldFilterTools } from '../util/toolFilter';
import { CopilotSdkExecutor } from '../util/copilotSdkExecutor';
import { selectModel } from '../util/selectModel';
import { refToUri } from '../util/refToUri';
import { ILogger } from '../platform/log/common/logService';
import { getMaxToolRounds, getMaxToolCount } from '../config/flowSettings';
import { ThinkingPanelHelper } from './thinkingPanelHelper';

/**
 * Flow execution engine - handles all execution strategies and prompt resolution.
 * Separated from FlowParticipant to keep participant logic focused on request routing.
 */
export class FlowEngine {
	/**
	 * Sentinel a role's response can contain to request that the flow stop
	 * before any not-yet-run roles/stages/groups execute — the escape gate for
	 * cases like a human-confirmation role reporting that the user declined to
	 * proceed. Detected as a plain substring match against the role's final text.
	 */
	static readonly CANCEL_MARKER = '<!-- flow:cancel -->';

	private readonly promptRenderer: FlowPromptRenderer;
	private readonly sdkExecutor: CopilotSdkExecutor;
	private readonly flowService: FlowService;
	private readonly contextBuilder: FlowContextBuilder;
	private readonly conversationStore: FlowConversationStore;
	private readonly log: ILogger;

	/** Stable session ID reused while the same VS Code chat conversation is active. */
	private currentSessionId: string | undefined;

	constructor(log: ILogger) {
		this.log = log;
		this.promptRenderer = new FlowPromptRenderer(log.createSubLogger('Renderer'));
		this.sdkExecutor = new CopilotSdkExecutor(log.createSubLogger('SdkExecutor'));
		this.flowService = new FlowService(log.createSubLogger('FlowService'));
		this.contextBuilder = new FlowContextBuilder();
		this.conversationStore = new FlowConversationStore();
	}

	/**
	 * Parse, validate, and execute a flow from a URI.
	 * Owns context building, conversation management, and orchestration dispatch.
	 */
	async execute(
		flowFileUri: vscode.Uri,
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult> {
		// Parse the flow configuration
		stream.progress('Parsing flow configuration...');
		const config = await this.flowService.parsePrompt(flowFileUri);

		if (!config) {
			stream.markdown('❌ **Error**: Failed to parse flow file. Please check the format.');
			return { errorDetails: { message: 'Invalid flow file format' } };
		}

		// Validate configuration
		const validation = this.flowService.validate(config);
		if (!validation.valid) {
			stream.markdown('❌ **Validation Errors**:\n\n');
			for (const error of validation.errors) {
				stream.markdown(`- ${error}\n`);
			}
			return { errorDetails: { message: 'Invalid flow configuration' } };
		}

		// Show what we're doing
		stream.markdown(`## ${config.name}\n\n`);
		if (config.description) {
			stream.markdown(`${config.description}\n\n`);
		}
		if (config.stages) {
			stream.markdown(`**Stages**: ${config.stages.map(s => `${s.name} (×${s.iterations ?? 1})`).join(' → ')}\n\n`);
		} else if (config.groups) {
			stream.markdown(`**Groups**: ${config.groups.map(g => g.name).join(', ')} → **${config.join?.name}** (join)\n\n`);
		} else {
			stream.markdown(`**Flow**: ${config.roles.map(r => r.name).join(', ')}\n\n`);
		}

		if (config.model) { stream.markdown(`**Model**: ${config.model}\n\n`); }
		if (config.customAgent) { stream.markdown(`**Agent**: ${config.customAgent}\n\n`); }
		if (config.tools && config.tools.length > 0) {
			stream.markdown(`**Tools**: ${config.tools.join(', ')}\n\n`);
		}
		stream.markdown('---\n\n');

		// Build rich context and manage conversation
		const vsCodeContext = this.contextBuilder.buildContext(request);
		if (context.history.length === 0) {
			this.currentSessionId = 'session-' + Date.now();
		}
		const sessionId = this.currentSessionId ?? 'session-default';
		const conversation = this.conversationStore.getOrCreate(sessionId);
		const currentTurn = conversation.addTurn(request.prompt, vsCodeContext);

		if (token.isCancellationRequested) {
			return {};
		}

		const history = conversation.getHistory().slice(0, -1);

		if (config.stages) {
			const responses = await this.executeIterative(
				config, request.prompt, vsCodeContext, history, stream, token,
				request.toolInvocationToken, request.model
			);
			for (const [key, content] of responses) {
				currentTurn.responses.set(key, content);
			}
		} else if (config.groups) {
			const responses = await this.executeForkJoin(
				config, request.prompt, vsCodeContext, history, stream, token,
				request.toolInvocationToken, request.model
			);
			for (const [roleName, content] of responses) {
				currentTurn.responses.set(roleName, content);
			}
		} else {
			const responses = await this.executePipeline(
				config, request.prompt, vsCodeContext, history, stream, token,
				request.toolInvocationToken, request.model
			);
			for (const [roleName, content] of responses) {
				currentTurn.responses.set(roleName, content);
			}
		}

		return {
			metadata: {
				roles: config.stages
					? config.stages.flatMap(s => s.roles.map(r => r.name))
					: config.groups
						? [...config.groups.flatMap(g => g.roles.map(r => `${g.name}:${r.name}`)), `join:${config.join?.name}`]
						: config.roles.map(r => r.name),
				category: config.category
			}
		};
	}

	/** Expose prompt rendering for follow-up turns. */
	async renderMessagesForContinuation(
		request: vscode.ChatRequest,
		history: ReadonlyArray<FlowTurn>,
		toolCallRounds: ToolCallRound[],
		toolCallResults: Record<string, vscode.LanguageModelToolResult>,
		model: vscode.LanguageModelChat,
		toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
		token: vscode.CancellationToken
	): Promise<{ messages: vscode.LanguageModelChatMessage[]; toolCallResults: Record<string, vscode.LanguageModelToolResult> }> {
		const vsCodeContext = this.contextBuilder.buildContext(request);
		const rawMaxInput = model.maxInputTokens || 32768;
		const maxPromptTokens = rawMaxInput > 16384
			? rawMaxInput - 8192
			: Math.floor(rawMaxInput * 0.75);

		return this.promptRenderer.renderRolePrompt(
			'Assistant',
			'You are a helpful AI coding assistant.',
			request.prompt,
			vsCodeContext,
			'',       // sharedContext — none for follow-up turns
			[],       // contextFiles — none for follow-up turns
			history,
			maxPromptTokens,
			toolCallRounds,
			toolCallResults,
			toolInvocationToken
		);
	}

	/**
	 * Sequential orchestration: roles respond one after another
	 */
	async executePipeline(
		config: IFlowConfig,
		userQuery: string,
		vsCodeContext: IFlowContext,
		history: FlowTurn[],
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
		currentChatModel: vscode.LanguageModelChat
	): Promise<Map<string, string>> {
		const responses = new Map<string, string>();
		const { tools, missingTools, blockedTools } = this.getFlowTools(config);
		
		// Warn user about missing tools
		if (missingTools.length > 0) {
			stream.markdown(`⚠️ **Warning**: The following tools are not available and will be ignored: \`${missingTools.join('`, `')}\`\n\n`);
			stream.markdown(`💡 **Tip**: Run the command "AI Flow: List Available Tools" to see registered tools.\n\n`);
		}
		
		// Warn user about blocked tools
		if (blockedTools.length > 0) {
			stream.markdown(`🚫 **Blocked Tools**: The following tools are incompatible with flows and have been excluded: \`${blockedTools.join('`, `')}\`\n\n`);
			stream.markdown(`💡 **Tip**: These tools are blocked due to technical limitations. See https://github.com/microsoft/vscode/issues/255855 for details.\n\n`);
		}
		
		for (const role of config.roles) {
			if (token.isCancellationRequested) {
				return responses;
			}

			const roleSkillRefs = [...(config.skills ?? []), ...(role.skills ?? [])];
			const roleContextRefs = [...(config.contexts ?? []), ...(role.contexts ?? [])];
			const augmentedSystemPrompt = await this.buildAugmentedSystemPrompt(
				role,
				roleSkillRefs,
				config.promptUri,
				userQuery,
				token
			);
			const flowDocContextFiles = await this.resolveContextFiles(roleContextRefs, config.promptUri, token);
			const refContextFiles = await this.resolveReferenceFiles(vsCodeContext.references, config.promptUri, token);
			const contextFiles = [...refContextFiles, ...flowDocContextFiles];
			const augmentedRole = { name: role.name, prompt: augmentedSystemPrompt, model: role.model };

			stream.markdown(`### ${role.name}\n\n`);
			stream.progress(`${role.name} is thinking...`);
			
			const response = role.delegate
				? await this.callRoleAgent(augmentedRole, userQuery, vsCodeContext, config.sharedContext ?? '', history, stream, token, contextFiles)
				: await this.callRole(
					augmentedRole, 
					userQuery, 
					vsCodeContext, 
					config.sharedContext,
					contextFiles,
					history,
					tools,
					stream,
					token,
					toolInvocationToken,
					currentChatModel
				);
			
			responses.set(role.name, response.content);
			
			if (response.error) {
				stream.markdown(`*Error: ${response.error}*\n\n`);
			} else {
				stream.markdown('\n\n');
			}
			
			if (response.model) {
				stream.markdown(`**Model: ${response.model}**\n\n`);
			}
			stream.markdown('---\n\n');

			if (response.outcome === 'cancel') {
				this.reportCancellation(stream, role.name);
				return responses;
			}
		}

		return responses;
	}

	/**
	 * Stage-based orchestration: stages run sequentially, each stage loops for iterations
	 */
	async executeIterative(
		config: IFlowConfig,
		userQuery: string,
		vsCodeContext: IFlowContext,
		history: FlowTurn[],
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
		currentChatModel: vscode.LanguageModelChat
	): Promise<Map<string, string>> {
		const responses = new Map<string, string>();
		const { tools, missingTools, blockedTools } = this.getFlowTools(config);
		if (missingTools.length > 0) {
			stream.markdown(`⚠️ **Warning**: Tools not available and will be ignored: \`${missingTools.join('`, `')}\`\n\n`);
		}
		if (blockedTools.length > 0) {
			stream.markdown(`🚫 **Blocked Tools**: The following tools are incompatible with flows and have been excluded: \`${blockedTools.join('`, `')}\`\n\n`);
		}

		let runningContext = userQuery;

		for (const stage of config.stages!) {
			if (token.isCancellationRequested) {
				return responses;
			}

			stream.markdown(`## Stage: ${stage.name}\n`);
			if (stage.iterations > 1) {
				stream.markdown(`*Up to ${stage.iterations} iteration(s)*\n\n`);
			} else {
				stream.markdown('\n');
			}

			const maxIter = stage.iterations;
			const inheritedSkillRefs = [...(config.skills ?? []), ...(stage.skills ?? [])];
			const inheritedContextRefs = [...(config.contexts ?? []), ...(stage.contexts ?? [])];

			for (let iter = 0; iter < maxIter; iter++) {
				if (token.isCancellationRequested) {
					return responses;
				}

				if (maxIter > 1) {
					stream.markdown(`### Iteration ${iter + 1} of ${maxIter}\n\n`);
				}

					let lastResponse = '';
				// Files touched by tool calls across all roles in this stage/iteration,
				// injected as context for every subsequent role.
				const stagedTouchedFiles: vscode.Uri[] = [];

				for (const role of stage.roles) {
					if (token.isCancellationRequested) {
						return responses;
					}

					stream.markdown(`#### ${role.name}\n\n`);
					stream.progress(`[${stage.name}] ${role.name} is thinking...`);

					const roleSkillRefs = [...inheritedSkillRefs, ...(role.skills ?? [])];
					const roleContextRefs = [...inheritedContextRefs, ...(role.contexts ?? [])];
					const augmentedSystemPrompt = await this.buildAugmentedSystemPrompt(
						role,
						roleSkillRefs,
						config.promptUri,
						runningContext,
						token
					);
					const flowDocContextFiles = await this.resolveContextFiles(roleContextRefs, config.promptUri, token);
					const refContextFiles = await this.resolveReferenceFiles(vsCodeContext.references, config.promptUri, token);
					// Re-read files that earlier roles in this stage touched so subsequent roles
					// (e.g. a reviewer) see the actual current content, not just a text summary.
					const touchedContextFiles = await this.resolveTouchedFiles(stagedTouchedFiles, token);
					const contextFiles = [...refContextFiles, ...touchedContextFiles, ...flowDocContextFiles];
					const augmentedRole = { name: role.name, prompt: augmentedSystemPrompt, model: role.model };

					const response = role.delegate
						? await this.callRoleAgent(augmentedRole, runningContext, vsCodeContext, config.sharedContext ?? '', history, stream, token, contextFiles)
						: await this.callRole(
							augmentedRole,
							runningContext,
							vsCodeContext,
							config.sharedContext,
							contextFiles,
							history,
							tools,
							stream,
							token,
							toolInvocationToken,
							currentChatModel
						);

					lastResponse = response.content;
					responses.set(`${stage.name}:${role.name}:iter${iter + 1}`, response.content);

					// Accumulate touched files so the next role in this stage can read them.
					if (response.touchedFiles) {
						for (const uri of response.touchedFiles) {
							if (!stagedTouchedFiles.some(u => u.toString() === uri.toString())) {
								stagedTouchedFiles.push(uri);
							}
						}
					}

					if (response.error) {
						stream.markdown(`*Error: ${response.error}*\n\n`);
					} else {
						stream.markdown('\n\n');
					}
					if (response.model) {
						stream.markdown(`**Model: ${response.model}**\n\n`);
					}
					stream.markdown('---\n\n');

					if (response.outcome === 'cancel') {
						this.reportCancellation(stream, role.name);
						return responses;
					}

					runningContext = `${runningContext}\n\n**[${stage.name} / ${role.name}]**:\n${response.content}`;
				}

				if (stage.doneWord && lastResponse.includes(stage.doneWord)) {
					if (maxIter > 1) {
						stream.markdown(`*Stage converged after iteration ${iter + 1}.*\n\n`);
					}
					break;
				}
			}
		}

		return responses;
	}

	/**
	 * Parallel orchestration: fork-join pattern.
	 * Each group's roles execute sequentially and independently. Group failures are
	 * non-fatal — remaining groups continue and failed groups surface a notice to
	 * the join role. After all groups complete, the join role evaluates their outputs
	 * via labeled context files ([Group: <name>]).
	 */
	async executeForkJoin(
		config: IFlowConfig,
		userQuery: string,
		vsCodeContext: IFlowContext,
		history: FlowTurn[],
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
		currentChatModel: vscode.LanguageModelChat
	): Promise<Map<string, string>> {
		const responses = new Map<string, string>();
		const groups = config.groups!;
		const join = config.join!;
		const { tools, missingTools, blockedTools } = this.getFlowTools(config);

		if (missingTools.length > 0) {
			stream.markdown(`⚠️ **Warning**: Tools not available and will be ignored: \`${missingTools.join('`, `')}\`\n\n`);
		}
		if (blockedTools.length > 0) {
			stream.markdown(`🚫 **Blocked Tools**: The following tools are incompatible with flows and have been excluded: \`${blockedTools.join('`, `')}\`\n\n`);
		}

		// ── FORK: run each group independently ──────────────────────────────
		const groupOutputs = new Map<string, string>();
		let cancelledBy: string | undefined;

		for (const group of groups) {
			if (token.isCancellationRequested) {
				return responses;
			}
			if (cancelledBy) {
				break;
			}

			stream.markdown(`## Group: ${group.name}\n\n`);
			stream.progress(`Running group: ${group.name}...`);

			try {
				let groupOutput = '';
				const groupSkillRefs = [...(config.skills ?? []), ...(group.skills ?? [])];
				const groupContextRefs = [...(config.contexts ?? []), ...(group.contexts ?? [])];

				for (const role of group.roles) {
					if (token.isCancellationRequested) {
						break;
					}

					const roleSkillRefs = [...groupSkillRefs, ...(role.skills ?? [])];
					const roleContextRefs = [...groupContextRefs, ...(role.contexts ?? [])];
					const augmentedSystemPrompt = await this.buildAugmentedSystemPrompt(
						role, roleSkillRefs, config.promptUri, userQuery, token
					);
					const flowDocContextFiles = await this.resolveContextFiles(roleContextRefs, config.promptUri, token);
					const refContextFiles = await this.resolveReferenceFiles(vsCodeContext.references, config.promptUri, token);
					const contextFiles = [...refContextFiles, ...flowDocContextFiles];
					const effectiveModel = role.model ?? group.model;
					const augmentedRole = { name: role.name, prompt: augmentedSystemPrompt, model: effectiveModel };

					stream.markdown(`### ${group.name} / ${role.name}\n\n`);
					stream.progress(`[${group.name}] ${role.name} is thinking...`);

					const response = role.delegate
						? await this.callRoleAgent(augmentedRole, userQuery, vsCodeContext, config.sharedContext ?? '', history, stream, token, contextFiles)
						: await this.callRole(
							augmentedRole,
							userQuery,
							vsCodeContext,
							config.sharedContext,
							contextFiles,
							history,
							tools,
							stream,
							token,
							toolInvocationToken,
							currentChatModel
						);

					groupOutput += response.content + '\n\n';
					responses.set(`${group.name}:${role.name}`, response.content);

					if (response.error) {
						stream.markdown(`*Error: ${response.error}*\n\n`);
					} else {
						stream.markdown('\n\n');
					}
					if (response.model) {
						stream.markdown(`**Model: ${response.model}**\n\n`);
					}
					stream.markdown('---\n\n');

					if (response.outcome === 'cancel') {
						cancelledBy = role.name;
						break;
					}
				}

				groupOutputs.set(group.name, groupOutput.trim());

			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				this.log.error(error instanceof Error ? error : String(error), `Group "${group.name}" failed`);
				stream.markdown(`⚠️ **Group "${group.name}" failed**: ${errorMsg}\n\n---\n\n`);
				groupOutputs.set(group.name, `⚠ Group failed: ${errorMsg}`);
			}
		}

		if (token.isCancellationRequested) {
			return responses;
		}
		if (cancelledBy) {
			this.reportCancellation(stream, cancelledBy);
			return responses;
		}

		// ── JOIN: synthesise group outputs ───────────────────────────────────
		const joinContextFiles: ContextFile[] = [];
		for (const [groupName, output] of groupOutputs) {
			joinContextFiles.push({ label: `[Group: ${groupName}]`, content: output });
		}

		stream.markdown(`## Join: ${join.name}\n\n`);
		stream.progress(`${join.name} is evaluating group outputs...`);

		const joinSkillRefs = [...(config.skills ?? []), ...(join.skills ?? [])];
		const joinContextRefs = [...(config.contexts ?? []), ...(join.contexts ?? [])];
		const augmentedJoinPrompt = await this.buildAugmentedSystemPrompt(
			join, joinSkillRefs, config.promptUri, userQuery, token
		);
		const joinFlowContextFiles = await this.resolveContextFiles(joinContextRefs, config.promptUri, token);
		const joinRefContextFiles = await this.resolveReferenceFiles(vsCodeContext.references, config.promptUri, token);
		// Group outputs (labeled) take precedence; flow/ref context files follow
		const allJoinContextFiles = [...joinContextFiles, ...joinRefContextFiles, ...joinFlowContextFiles];
		const augmentedJoin = { name: join.name, prompt: augmentedJoinPrompt, model: join.model };

		const joinResponse = await this.callRole(
			augmentedJoin,
			userQuery,
			vsCodeContext,
			config.sharedContext,
			allJoinContextFiles,
			history,
			tools,
			stream,
			token,
			toolInvocationToken,
			currentChatModel
		);

		responses.set(`join:${join.name}`, joinResponse.content);

		if (joinResponse.error) {
			stream.markdown(`*Error: ${joinResponse.error}*\n\n`);
		} else {
			stream.markdown('\n\n');
		}
		if (joinResponse.model) {
			stream.markdown(`**Model: ${joinResponse.model}**\n\n`);
		}
		stream.markdown('---\n\n');

		if (joinResponse.outcome === 'cancel') {
			this.reportCancellation(stream, join.name);
		}

		return responses;
	}

	// ------------------------------------------------------------------
	// Tool Management
	// ------------------------------------------------------------------

	/**
	 * Get tools array from flow config, filtering out blocked tools
	 */
	private getFlowTools(config: IFlowConfig): { tools: vscode.LanguageModelChatTool[] | undefined; missingTools: ReadonlyArray<string>; blockedTools: ReadonlyArray<string> } {
		const allTools = vscode.lm.tools;
		if (!allTools) {
			this.log.warn('vscode.lm.tools is undefined');
			return { tools: undefined, missingTools: config.tools ?? [], blockedTools: [] };
		}

		// Omitted or empty tools array → wildcard: grant all available tools.
		if (!config.tools || config.tools.length === 0 || config.tools.includes('*')) {
			this.log.debug(`Wildcard '*' detected - ${allTools.length} tools available`);
			// Filter out blocked tools from wildcard
			const filteredTools = allTools.filter(tool => !BLOCKED_TOOLS.has(tool.name));
			const blockedTools = allTools.filter(tool => BLOCKED_TOOLS.has(tool.name)).map(t => t.name);
			if (blockedTools.length > 0) {
				this.log.warn(`Blocked tools excluded: ${blockedTools.join(', ')}`);
			}
			return { tools: filteredTools.length > 0 ? filteredTools : undefined, missingTools: [], blockedTools };
		}
		
		const matchedTools = allTools.filter(tool => 
			config.tools?.includes(tool.name)
		);
		
		const blockedTools = matchedTools.filter(tool => BLOCKED_TOOLS.has(tool.name)).map(t => t.name);
		const availableTools = matchedTools.filter(tool => !BLOCKED_TOOLS.has(tool.name));
		
		const unmatchedTools = config.tools.filter(name => 
			!allTools.some(tool => tool.name === name)
		);
		
		if (unmatchedTools.length > 0) {
			this.log.warn(`Tools not found: ${unmatchedTools.join(', ')}`);
		}
		
		if (blockedTools.length > 0) {
			this.log.warn(`Blocked tools excluded: ${blockedTools.join(', ')}`);
		}
		
		return {
			tools: availableTools.length > 0 ? availableTools : undefined,
			missingTools: unmatchedTools,
			blockedTools
		};
	}

	// ------------------------------------------------------------------
	// Role Execution
	// ------------------------------------------------------------------

	/** Detects the flow-cancel sentinel in a role's final response text. */
	private deriveOutcome(content: string): 'cancel' | undefined {
		return content.includes(FlowEngine.CANCEL_MARKER) ? 'cancel' : undefined;
	}

	/** Announces that the flow is stopping early because `roleName` requested cancellation. */
	private reportCancellation(stream: vscode.ChatResponseStream, roleName: string): void {
		stream.markdown(`\n> ⛔ **Flow cancelled by ${roleName}** — remaining steps skipped.\n\n`);
	}

	/**
	 * Call a role using GitHub Copilot SDK
	 */
	private async callRoleAgent(
		role: { name: string; prompt: string; model?: string },
		userQuery: string,
		vsCodeContext: IFlowContext,
		sharedContext: string,
		history: FlowTurn[],
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		contextFiles?: ContextFile[]
	): Promise<IRoleResponse> {
		try {
			// Serialize context files into sharedContext for SDK execution
			let effectiveSharedContext = sharedContext;
			if (contextFiles && contextFiles.length > 0) {
				const filesSection = contextFiles.map(f => `## ${f.label}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
				effectiveSharedContext = effectiveSharedContext
					? `${effectiveSharedContext}\n\n${filesSection}`
					: filesSection;
			}
			const result = await this.sdkExecutor.executeCopilotSdk({
				roleName: role.name,
				prompt: role.prompt,
				userQuery,
				context: vsCodeContext,
				sharedContext: effectiveSharedContext,
				history,
				model: role.model,
				token,
				onProgress: (message) => {
					stream.progress(message);
				}
			});

			return { ...result, outcome: this.deriveOutcome(result.content) };

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.log.error(error instanceof Error ? error : String(error), `Error in callRoleAgent for ${role.name}`);
			return {
				roleName: role.name,
				content: '',
				model: role.model || 'claude-sonnet-4.5',
				error: errorMessage
			};
		}
	}

	/**
	 * Call a language model for a specific role using Prompt-TSX
	 */
	private async callRole(
		role: { name: string; prompt: string; model?: string },
		userQuery: string,
		vsCodeContext: IFlowContext,
		sharedContext: string,
		contextFiles: ContextFile[],
		history: FlowTurn[],
		tools: vscode.LanguageModelChatTool[] | undefined,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
		currentChatModel: vscode.LanguageModelChat
	): Promise<IRoleResponse> {
		try {
			let model: vscode.LanguageModelChat;
			if (role.model) {
				const resolved = await selectModel(role.model, currentChatModel, this.log);
				if (!resolved) {
					return { roleName: role.name, content: '', model: role.model, error: 'No language model available' };
				}
				model = resolved;
			} else {
				model = currentChatModel;
			}

			const rawMaxInput = model.maxInputTokens || 32768;
			const maxPromptTokens = rawMaxInput > 16384
				? rawMaxInput - 8192
				: Math.floor(rawMaxInput * 0.75);
			this.log.debug(`Model: ${model.name}, maxInputTokens=${model.maxInputTokens}, using maxPromptTokens=${maxPromptTokens}`);
			
			let responseText = '';
			const maxToolRounds = 100;
			let toolRound = 0;
			const toolCallRounds: ToolCallRound[] = [];
			let toolCallResults: Record<string, vscode.LanguageModelToolResult> = {};
			// Track files created/modified by tool calls so callers can inject them
			// as context into subsequent roles (e.g. reviewer sees the actual file).
			const touchedFileUris: vscode.Uri[] = [];
			// One panel per role turn — reused across tool rounds so consecutive reasoning
			// bursts render as a single grouped "thinking" panel instead of one per round.
			const thinking = new ThinkingPanelHelper(stream, role.name);

			while (toolRound < maxToolRounds) {
				if (token.isCancellationRequested) {
					break;
				}
				
				this.log.trace(`Starting tool round ${toolRound + 1} of ${maxToolRounds} for role ${role.name}`);

				const renderResult = await this.promptRenderer.renderRolePrompt(
					role.name,
					role.prompt,
					userQuery,
					vsCodeContext,
					sharedContext,
					contextFiles,
					history,
					maxPromptTokens,
					toolCallRounds,
					toolCallResults,
					toolInvocationToken
				);
				
				this.log.debug(`Prompt rendered: ${renderResult.messages.length} messages`);
				
				toolCallResults = { ...toolCallResults, ...renderResult.toolCallResults };
				
				const messages = renderResult.messages;
				
				if (messages.length === 0) {
					this.log.error(`renderPrompt returned 0 messages for ${role.name} — aborting`);
					return { roleName: role.name, content: '', model: model.name, error: 'No prompt messages generated' };
				}

				const runtimeCaps = (model as unknown as { capabilities?: { toolCalling?: boolean | number } }).capabilities;
				const modelSupportsTools = runtimeCaps ? runtimeCaps.toolCalling !== false : true;
				if (!modelSupportsTools) {
					this.log.warn(`Model ${model.name} reports toolCalling=false — skipping tools`);
				}

				const options: vscode.LanguageModelChatRequestOptions = {};
				if (tools && tools.length > 0 && modelSupportsTools) {
					let filteredTools = tools;
					if (shouldFilterTools(tools.length)) {
						this.log.debug(`Applying smart tool filtering (${tools.length} -> max ${getMaxToolCount()})`);
						filteredTools = filterTools(tools, userQuery, undefined, this.log);
					}
					
					const normalizedTools = normalizeToolSchemas(filteredTools);
					options.tools = normalizedTools;
					this.log.debug(`Using ${normalizedTools.length} tools`);
				}
				
				const ThinkingPartCtor = (vscode as unknown as Record<string, unknown>)['LanguageModelThinkingPart'] as (new (...args: unknown[]) => unknown) | undefined;
				const isThinkingPart = (part: unknown): part is { value: string | string[]; id?: string; metadata?: Record<string, unknown> } =>
					(ThinkingPartCtor && part instanceof ThinkingPartCtor) || (part as object)?.constructor?.name === 'LanguageModelThinkingPart';

				const streamParts = async (req: vscode.LanguageModelChatResponse): Promise<{ text: string; calls: vscode.LanguageModelToolCallPart[] }> => {
					const calls: vscode.LanguageModelToolCallPart[] = [];
					let text = '';
					try {
						for await (const part of req.stream) {
							if (token.isCancellationRequested) { break; }
							if (part instanceof vscode.LanguageModelTextPart) {
								thinking.closeForText();
								text += part.value;
								stream.markdown(part.value);
							} else if (part instanceof vscode.LanguageModelToolCallPart) {
								thinking.closeForAction();
								calls.push(part);
								stream.progress(`🔧 ${part.name}(...)`);
								this.log.trace(`Received tool call: ${part.name} (callId: ${part.callId})`);
							} else if (part instanceof vscode.LanguageModelDataPart) {
								if (part.mimeType.startsWith('text/')) {
									try {
										const decoded = new TextDecoder().decode(part.data);
										text += decoded;
										stream.markdown(decoded);
									} catch { /* ignore */ }
								}
							} else if (isThinkingPart(part)) {
								const thinkText = Array.isArray(part.value) ? part.value.join('') : (part.value ?? '');
								thinking.pushDelta(thinkText);
							}
						}
						thinking.closeForAction();
					} catch (streamErr) {
						this.log.error(streamErr instanceof Error ? streamErr : String(streamErr), `Stream error in round ${toolRound + 1}`);
						stream.markdown(`\n> ❌ **Stream error (${role.name})**: ${String(streamErr)}\n\n`);
					}
					return { text, calls };
				};
				
				const label = `Round ${toolRound + 1}: ${messages.length} msg(s) → ${model.name}`;
				this.log.trace(label);
				stream.progress(label);
				
				const chatRequest = await model.sendRequest(messages, options, token);
				const { text: initialText, calls: toolCalls } = await streamParts(chatRequest);
				let roundText = initialText;
				
				if (roundText === '' && toolCalls.length === 0 && options.tools && options.tools.length > 0) {
					this.log.warn('Empty response with tools — retrying without tools');
					stream.progress('Tools caused empty response — retrying without tools…');
					const retryRequest = await model.sendRequest(messages, {}, token);
					const retry = await streamParts(retryRequest);
					roundText = retry.text;
					toolCalls.push(...retry.calls);
				}
				
				responseText += roundText;
				
				this.log.trace(`Round ${toolRound + 1}: roundText length=${roundText.length}, toolCalls=${toolCalls.length}`);
				
				if (toolCalls.length === 0) {
					this.log.trace(`No tool calls in round ${toolRound + 1}, exiting loop`);
					break;
				}

				toolCallRounds.push({
					response: roundText,
					toolCalls
				});

				type ExternalEditStream = { externalEdit: (uris: vscode.Uri[], cb: () => Promise<void>) => Promise<string> };
				const extStream = (stream as unknown as ExternalEditStream);
				const hasExternalEdit = typeof extStream.externalEdit === 'function';
				for (const tc of toolCalls) {
					if (toolCallResults[tc.callId]) {
						continue;
					}
					if (tc.name === 'copilot_createFile' || tc.name === 'create_file') {
						const input = tc.input as { filePath?: string; content?: string };
						if (!input.filePath || input.content === undefined) {
							toolCallResults[tc.callId] = { content: [new vscode.LanguageModelTextPart('Error: Missing filePath or content')] };
							continue;
						}
						const fileUri = vscode.Uri.file(input.filePath);
						try {
							if (hasExternalEdit) {
								await extStream.externalEdit([fileUri], async () => {
									await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(input.content!));
								});
							} else {
								await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(input.content!));
							}
							toolCallResults[tc.callId] = { content: [new vscode.LanguageModelTextPart(`File created successfully: ${input.filePath}`)] };
							touchedFileUris.push(fileUri);
							this.log.debug(`File created: ${input.filePath}`);
						} catch (err) {
							toolCallResults[tc.callId] = { content: [new vscode.LanguageModelTextPart(`File creation error: ${err instanceof Error ? err.message : String(err)}`)] };
						}
					}
				}

				stream.progress(`Processing tool results (round ${toolRound + 1}/${maxToolRounds})...`);
				
				toolRound++;
			}
			
			if (toolRound >= maxToolRounds) {
				this.log.warn(`Role ${role.name} hit max tool rounds (${maxToolRounds})`);
				stream.markdown(`\n> ⚠️ **${role.name}**: reached max tool rounds (${maxToolRounds})\n\n`);
			}
			
			const finalContent = responseText.trim();
			if (!finalContent) {
				this.log.warn(`Role ${role.name} returned empty content`);
				stream.markdown(`\n> ⚠️ **${role.name}** returned an empty response. Model: ${model.name}\n\n`);
			}

			return {
				roleName: role.name,
				content: finalContent,
				model: model.name,
				touchedFiles: touchedFileUris.length > 0 ? touchedFileUris : undefined,
				outcome: this.deriveOutcome(finalContent)
			};
			
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.log.error(error instanceof Error ? error : errorMessage, `Error in callRole for ${role.name}`);
			return {
				roleName: role.name,
				content: '',
				model: role.model || 'unknown',
				error: errorMessage
			};
		}
	}

	// ------------------------------------------------------------------
	// Prompt Resolution
	// ------------------------------------------------------------------

	/**
	 * Build the effective system prompt for a role
	 */
	private async buildAugmentedSystemPrompt(
		role: { prompt?: IPromptRef; agent?: IAgentRef; args?: string },
		skillRefs: ReadonlyArray<ISkillRef>,
		flowUri: vscode.Uri,
		userQuery: string,
		token: vscode.CancellationToken
	): Promise<string> {
		const effectiveArgs = role.args ?? userQuery;

		let basePrompt = '';
		if (role.prompt) {
			basePrompt = await this.resolvePromptContent(role.prompt, flowUri, token) ?? '';
		}

		if (role.agent) {
			const agentContent = await this.resolveAgentContent(role.agent, flowUri, token);
			if (agentContent) {
				const substituted = agentContent.replace(/\$ARGUMENTS/g, effectiveArgs);
				basePrompt = basePrompt
					? `${basePrompt}\n\n---\n## Agent Instructions\n\n${substituted}`
					: substituted;
			}
		}

		if (!basePrompt) {
			basePrompt = 'You are a helpful assistant.';
		}

		if (skillRefs.length === 0) {
			return basePrompt;
		}
		const contents: string[] = [];
		for (const ref of skillRefs) {
			const content = await this.resolveSkillContent(ref, flowUri, token);
			if (content) {
				contents.push(content.replace(/\$ARGUMENTS/g, effectiveArgs));
			}
		}
		if (contents.length === 0) {
			return basePrompt;
		}
		return `${basePrompt}\n\n---\n## Applicable Skills\n\n${contents.join('\n\n---\n\n')}`;
	}

	/**
	 * Resolve a prompt reference to its content
	 */
	async resolvePromptContent(
		ref: IPromptRef,
		flowUri: vscode.Uri,
		_token: vscode.CancellationToken
	): Promise<string | undefined> {
		try {
			if (typeof ref === 'string') {
				return ref.trim() || undefined;
			}

			if ('uri' in ref) {
				const uriStr = ref.uri.trim();
				let promptUri: vscode.Uri;
				if (uriStr.startsWith('file://')) {
					promptUri = vscode.Uri.parse(uriStr);
				} else if (uriStr.startsWith('/') || /^[A-Za-z]:/.test(uriStr)) {
					promptUri = vscode.Uri.file(uriStr);
				} else {
					promptUri = vscode.Uri.joinPath(vscode.Uri.joinPath(flowUri, '..'), uriStr);
				}
				const bytes = await vscode.workspace.fs.readFile(promptUri);
				const text = Buffer.from(bytes).toString('utf8');
				this.log.debug(`Resolved prompt from URI: ${promptUri.fsPath}`);
				const parts = text.split(/^---\s*$/m);
				return parts.length >= 3 ? parts.slice(2).join('---').trim() : text.trim();
			}

			if ('name' in ref) {
				const name = ref.name.trim();
				const filename = name.endsWith('.prompt.md') ? name : `${name}.prompt.md`;
				const filenameAlt = name.endsWith('.prompt.md') ? name.replace('.prompt.md', '') : name;

				const wsFolder = vscode.workspace.workspaceFolders?.[0];
				const candidates: vscode.Uri[] = [];

				if (wsFolder) {
					candidates.push(
						vscode.Uri.joinPath(wsFolder.uri, '.github', 'prompts', filename),
						vscode.Uri.joinPath(wsFolder.uri, '.github', 'prompts', filenameAlt),
						vscode.Uri.joinPath(wsFolder.uri, '.vscode', 'prompts', filename),
						vscode.Uri.joinPath(wsFolder.uri, '.vscode', 'prompts', filenameAlt),
					);
				}

				const userHome = process.env.HOME || process.env.USERPROFILE;
				if (userHome) {
					candidates.push(
						vscode.Uri.joinPath(vscode.Uri.file(userHome), '.copilot', 'prompts', filename),
						vscode.Uri.joinPath(vscode.Uri.file(userHome), '.copilot', 'prompts', filenameAlt),
					);
				}

				for (const candidate of candidates) {
					try {
						await vscode.workspace.fs.stat(candidate);
						const bytes = await vscode.workspace.fs.readFile(candidate);
						const text = Buffer.from(bytes).toString('utf8');
						this.log.debug(`Resolved prompt from name: ${candidate.fsPath}`);
						const parts = text.split(/^---\s*$/m);
						return parts.length >= 3 ? parts.slice(2).join('---').trim() : text.trim();
					} catch {
						// not found
					}
				}

				this.log.warn(`Prompt not found by name: ${name}`);
				return undefined;
			}

			return undefined;
		} catch (error) {
			this.log.warn(`Failed to resolve prompt: ${error}`);
			return undefined;
		}
	}

	/**
	 * Resolve context file references
	 */
	async resolveContextFiles(
		refs: ReadonlyArray<IContextRef>,
		flowUri: vscode.Uri,
		token: vscode.CancellationToken
	): Promise<ContextFile[]> {
		if (refs.length === 0) { return []; }
		const results: ContextFile[] = [];
		for (const ref of refs) {
			if (token.isCancellationRequested) { break; }
			const content = await this.resolveContextContent(ref, flowUri, token);
			if (content !== undefined) {
				const label = typeof ref === 'string' ? ref : ref.path;
				results.push({ label, content });
			}
		}
		return results;
	}

	/**
	 * Resolve a context file reference to its content
	 */
	private async resolveContextContent(
		ref: IContextRef,
		flowUri: vscode.Uri,
		_token: vscode.CancellationToken
	): Promise<string | undefined> {
		try {
			const p = typeof ref === 'string' ? ref : ref.path;
			const flowDir = vscode.Uri.joinPath(flowUri, '..');

			const candidates: vscode.Uri[] = [
				vscode.Uri.joinPath(flowDir, p),
			];
			const wsFolder = vscode.workspace.workspaceFolders?.[0];
			if (wsFolder) {
				candidates.push(vscode.Uri.joinPath(wsFolder.uri, p));
			}

			for (const candidate of candidates) {
				try {
					await vscode.workspace.fs.stat(candidate);
						const bytes = await vscode.workspace.fs.readFile(candidate);
					const text = Buffer.from(bytes).toString('utf8');
					this.log.debug(`Resolved context: ${candidate.fsPath}`);
					return text.trim();
				} catch {
					// not found
				}
			}
			this.log.warn(`Context file not found: ${p}`);
			return undefined;
		} catch (error) {
			this.log.warn(`Failed to resolve context: ${error}`);
			return undefined;
		}
	}

	/**
	 * Read the current content of files that were touched by tool calls in a previous
	 * role. Deduplicates by URI. Skips unreadable files silently.
	 */
	private async resolveTouchedFiles(
		uris: readonly vscode.Uri[],
		token: vscode.CancellationToken
	): Promise<ContextFile[]> {
		const results: ContextFile[] = [];
		for (const uri of uris) {
			if (token.isCancellationRequested) { break; }
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				const content = Buffer.from(bytes).toString('utf8');
				const label = vscode.workspace.asRelativePath(uri, false);
				results.push({ label: `[changed] ${label}`, content });
			} catch {
				// file may have been deleted or is unreadable — skip
			}
		}
		return results;
	}

	/**
	 * Resolve reference files from chat attachments
	 */
	async resolveReferenceFiles(
		refs: readonly vscode.ChatPromptReference[],
		flowFileUri: vscode.Uri,
		token: vscode.CancellationToken
	): Promise<ContextFile[]> {
		const results: ContextFile[] = [];
		for (const ref of refs) {
			if (token.isCancellationRequested) { break; }

			const uri = refToUri(ref);
			if (!uri) { continue; }
			if (uri.toString() === flowFileUri.toString()) { continue; }

			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				const content = Buffer.from(bytes).toString('utf8');
				const label = vscode.workspace.asRelativePath(uri, false);
				results.push({ label, content });
			} catch {
				// skip unreadable files
			}
		}
		return results;
	}

	/**
	 * Resolve an agent reference to its content
	 */
	private async resolveAgentContent(
		ref: IAgentRef,
		flowUri: vscode.Uri,
		_token: vscode.CancellationToken
	): Promise<string | undefined> {
		try {
			let agentUri: vscode.Uri | undefined;

			if (typeof ref === 'string') {
				const name = ref.trim();
				const wsFolder = vscode.workspace.workspaceFolders?.[0];
				if (wsFolder) {
					const candidates = [
						vscode.Uri.joinPath(wsFolder.uri, '.github', 'agents', `${name}.agent.md`),
						vscode.Uri.joinPath(wsFolder.uri, '.agents', `${name}.agent.md`),
						vscode.Uri.joinPath(wsFolder.uri, '.github', 'agents', name),
					];
					for (const candidate of candidates) {
						try {
							await vscode.workspace.fs.stat(candidate);
							agentUri = candidate;
							break;
						} catch {
							// not found
						}
					}
				}
			} else {
				agentUri = vscode.Uri.joinPath(vscode.Uri.joinPath(flowUri, '..'), ref.path);
			}

			if (!agentUri) {
				this.log.warn(`Agent not found: ${typeof ref === 'string' ? ref : ref.path}`);
				return undefined;
			}

			this.log.debug(`Resolved agent: ${agentUri.fsPath}`);
			const bytes = await vscode.workspace.fs.readFile(agentUri);
			const text = Buffer.from(bytes).toString('utf8');
			const parts = text.split(/^---\s*$/m);
			return parts.length >= 3 ? parts.slice(2).join('---').trim() : text.trim();
		} catch (error) {
			this.log.warn(`Failed to resolve agent: ${error}`);
			return undefined;
		}
	}

	/**
	 * Resolve a skill reference to its content
	 */
	private async resolveSkillContent(
		ref: ISkillRef,
		flowUri: vscode.Uri,
		token: vscode.CancellationToken
	): Promise<string | undefined> {
		try {
			let skillUri: vscode.Uri | undefined;

			if (typeof ref === 'string') {
				const getSkills = (vscode.chat as { getSkills?: (t: vscode.CancellationToken) => Thenable<readonly { name: string; uri: vscode.Uri }[]> }).getSkills;
				if (typeof getSkills === 'function') {
					const platformSkills = await getSkills.call(vscode.chat, token);
					const match = platformSkills.find(s => s.name.toLowerCase() === ref.toLowerCase());
					if (match) {
						skillUri = match.uri;
					}
				}
				if (!skillUri) {
					const wsFolder = vscode.workspace.workspaceFolders?.[0];
					if (wsFolder) {
						for (const searchPath of ['.agents/skills', '.github/skills']) {
							const candidate = vscode.Uri.joinPath(wsFolder.uri, searchPath, ref, 'SKILL.md');
							try {
								await vscode.workspace.fs.stat(candidate);
								skillUri = candidate;
								break;
							} catch {
								// not found
							}
						}
					}
				}
			} else {
				skillUri = vscode.Uri.joinPath(vscode.Uri.joinPath(flowUri, '..'), ref.path);
			}

			if (!skillUri) {
				this.log.warn(`Skill not found: ${typeof ref === 'string' ? ref : ref.path}`);
				return undefined;
			}

			const bytes = await vscode.workspace.fs.readFile(skillUri);
			const text = Buffer.from(bytes).toString('utf8');
			const parts = text.split(/^---\s*$/m);
			return parts.length >= 3 ? parts.slice(2).join('---').trim() : text.trim();
		} catch (error) {
			this.log.warn(`Failed to resolve skill: ${error}`);
			return undefined;
		}
	}
}