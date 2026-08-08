/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { FlowEngine } from './flowEngine';
import type { IFlowConfig, IRoleResponse } from './flowService';
import type { IFlowContext } from '../context/flowContextBuilder';
import { NullLogService } from '../platform/log/common/logService';

/** Minimal interface for spying on FlowEngine private methods in tests. */
interface IEngineInternals {
	callRole(role: { name: string; prompt: string; model?: string }, ...rest: unknown[]): Promise<IRoleResponse>;
	buildAugmentedSystemPrompt(...args: unknown[]): Promise<string>;
	resolveContextFiles(...args: unknown[]): Promise<unknown[]>;
	resolveReferenceFiles(...args: unknown[]): Promise<unknown[]>;
	getFlowTools(...args: unknown[]): { tools: unknown[]; missingTools: string[]; blockedTools: string[] };
	deriveOutcome(content: string): 'cancel' | undefined;
}

function makeConfig(overrides: Partial<IFlowConfig> = {}): IFlowConfig {
	return {
		name: 'Test Flow',
		roles: [],
		sharedContext: '',
		promptUri: vscode.Uri.file('/test.flow.yaml'),
		...overrides
	} as IFlowConfig;
}

function makeEngine() {
	const engine = new FlowEngine(new NullLogService());
	const eng = engine as unknown as IEngineInternals;
	vi.spyOn(eng, 'buildAugmentedSystemPrompt').mockResolvedValue('sys');
	vi.spyOn(eng, 'resolveContextFiles').mockResolvedValue([]);
	vi.spyOn(eng, 'resolveReferenceFiles').mockResolvedValue([]);
	vi.spyOn(eng, 'getFlowTools').mockReturnValue({ tools: [], missingTools: [], blockedTools: [] });
	return { engine, eng };
}

function makeStream() {
	return { markdown: vi.fn(), progress: vi.fn() } as unknown as vscode.ChatResponseStream;
}

const token = { isCancellationRequested: false } as vscode.CancellationToken;
const vsCodeContext = { references: [] } as unknown as IFlowContext;

// ── Cancel-marker detection ─────────────────────────────────────────────────

describe('FlowEngine — cancel-outcome detection', () => {
	it('flags content containing the cancel marker', () => {
		const { eng } = makeEngine();
		expect(eng.deriveOutcome(`Not proceeding.\n${FlowEngine.CANCEL_MARKER}`)).toBe('cancel');
	});

	it('leaves ordinary content undetected', () => {
		const { eng } = makeEngine();
		expect(eng.deriveOutcome('Looks good, proceeding as planned.')).toBeUndefined();
	});
});

// ── executePipeline() ────────────────────────────────────────────────────────

describe('FlowEngine.executePipeline() — cancel gate', () => {
	it('skips not-yet-run roles once a role reports the cancel outcome', async () => {
		const { engine, eng } = makeEngine();
		const callRoleSpy = vi.spyOn(eng, 'callRole').mockImplementation(async role => ({
			roleName: role.name,
			content: `output-from-${role.name}`,
			model: 'stub',
			outcome: role.name === 'Gate' ? 'cancel' : undefined
		}));

		const config = makeConfig({
			roles: [
				{ name: 'Analyst', prompt: 'p' },
				{ name: 'Gate', prompt: 'p' },
				{ name: 'Implementer', prompt: 'p' }
			]
		});

		const stream = makeStream();
		const responses = await engine.executePipeline(
			config, 'q', vsCodeContext, [], stream, token, undefined, {} as vscode.LanguageModelChat
		);

		expect(responses.has('Analyst')).toBe(true);
		expect(responses.has('Gate')).toBe(true);
		expect(responses.has('Implementer')).toBe(false);
		expect(callRoleSpy).toHaveBeenCalledTimes(2);

		const markdownCalls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls;
		expect(markdownCalls.some(args => (args[0] as string).includes('cancelled by Gate'))).toBe(true);
	});
});

// ── executeIterative() ───────────────────────────────────────────────────────

describe('FlowEngine.executeIterative() — cancel gate', () => {
	it('skips remaining roles, iterations, and stages once cancelled', async () => {
		const { engine, eng } = makeEngine();
		vi.spyOn(eng, 'callRole').mockImplementation(async role => ({
			roleName: role.name,
			content: `output-from-${role.name}`,
			model: 'stub',
			outcome: role.name === 'Gate' ? 'cancel' : undefined
		}));

		const config = makeConfig({
			stages: [
				{
					name: 'Draft',
					iterations: 3,
					roles: [{ name: 'Writer', prompt: 'p' }, { name: 'Gate', prompt: 'p' }]
				},
				{
					name: 'Review',
					iterations: 1,
					roles: [{ name: 'Critic', prompt: 'p' }]
				}
			]
		});

		const stream = makeStream();
		const responses = await engine.executeIterative(
			config, 'q', vsCodeContext, [], stream, token, undefined, {} as vscode.LanguageModelChat
		);

		expect(responses.has('Draft:Writer:iter1')).toBe(true);
		expect(responses.has('Draft:Gate:iter1')).toBe(true);
		// Neither the rest of the Draft stage's iterations nor the Review stage should run.
		expect(responses.has('Draft:Writer:iter2')).toBe(false);
		expect(responses.has('Review:Critic:iter1')).toBe(false);
	});
});

// ── executeForkJoin() ────────────────────────────────────────────────────────

describe('FlowEngine.executeForkJoin() — cancel gate', () => {
	it('skips remaining groups and the join role once a group role cancels', async () => {
		const { engine, eng } = makeEngine();
		const callRoleSpy = vi.spyOn(eng, 'callRole').mockImplementation(async role => ({
			roleName: role.name,
			content: `output-from-${role.name}`,
			model: 'stub',
			outcome: role.name === 'Gate' ? 'cancel' : undefined
		}));

		const config = makeConfig({
			groups: [
				{ name: 'Alpha', roles: [{ name: 'Gate', prompt: 'p' }] },
				{ name: 'Beta', roles: [{ name: 'Writer', prompt: 'p' }] }
			],
			join: { name: 'Synthesiser', prompt: 'Combine outputs.' }
		});

		const stream = makeStream();
		const responses = await engine.executeForkJoin(
			config, 'q', vsCodeContext, [], stream, token, undefined, {} as vscode.LanguageModelChat
		);

		expect(responses.has('Alpha:Gate')).toBe(true);
		expect(responses.has('Beta:Writer')).toBe(false);
		expect(responses.has('join:Synthesiser')).toBe(false);
		expect(callRoleSpy).toHaveBeenCalledTimes(1);

		const markdownCalls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls;
		expect(markdownCalls.some(args => (args[0] as string).includes('cancelled by Gate'))).toBe(true);
	});
});
