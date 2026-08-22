#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLI_COMMANDS = void 0;
exports.parseTokens = parseTokens;
exports.parseArgv = parseArgv;
exports.stringFlag = stringFlag;
exports.resolveCommandSpec = resolveCommandSpec;
exports.resolveCommand = resolveCommand;
exports.runCli = runCli;
const index_1 = require("./index");
exports.CLI_COMMANDS = {
    instances: { scopes: [] },
    status: { method: 'orbit.session.list', context: 'connection', scopes: ['read'] },
    operation: { method: 'orbit.operation.get', context: 'connection', scopes: ['read'] },
    start: { method: 'orbit.session.start', context: 'projectMutation', scopes: ['read', 'session.control'] },
    stop: { method: 'orbit.session.stop', context: 'targetMutation', scopes: ['read', 'session.control'] },
    pause: { method: 'orbit.target.pause', context: 'targetMutation', scopes: ['read', 'session.control'] },
    continue: { method: 'orbit.target.continue', context: 'targetMutation', scopes: ['read', 'session.control'] },
    step: { method: 'orbit.target.stepInto', context: 'targetMutation', scopes: ['read', 'session.control'] },
    breakpoints: { method: 'orbit.breakpoints.list', context: 'connection', scopes: ['read'] },
    read: { method: 'orbit.expression.readMany', context: 'target', scopes: ['read'] },
    write: { method: 'orbit.expression.writeMany', context: 'targetMutation', scopes: ['read', 'variables.write'] },
    'memory-read': { method: 'orbit.memory.read', context: 'target', scopes: ['read'] },
    record: { method: 'orbit.record.list', context: 'target', scopes: ['read'] },
};
/** Parses a token list (no leading command) into positionals and flags. */
function parseTokens(tokens) {
    const parsed = { command: undefined, positional: [], flags: new Map() };
    for (let index = 0; index < tokens.length; index += 1) {
        const argument = tokens[index];
        if (!argument.startsWith('--')) {
            parsed.positional.push(argument);
            continue;
        }
        const separator = argument.indexOf('=');
        if (separator > 2) {
            parsed.flags.set(argument.slice(2, separator), argument.slice(separator + 1));
            continue;
        }
        const name = argument.slice(2);
        const next = tokens[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
            parsed.flags.set(name, next);
            index += 1;
        }
        else {
            parsed.flags.set(name, true);
        }
    }
    return parsed;
}
function parseArgv(argv) {
    return { ...parseTokens(argv.slice(1)), command: argv[0] };
}
function parseArguments(argv) {
    return parseArgv(argv);
}
function stringFlag(parsed, name) {
    const value = parsed.flags.get(name);
    return typeof value === 'string' ? value : undefined;
}
const STEP_METHODS = {
    into: 'orbit.target.stepInto',
    over: 'orbit.target.stepOver',
    out: 'orbit.target.stepOut',
    instruction: 'orbit.target.stepInstruction',
};
const BREAKPOINT_METHODS = {
    list: 'orbit.breakpoints.list',
    add: 'orbit.breakpoints.add',
    update: 'orbit.breakpoints.update',
    remove: 'orbit.breakpoints.remove',
    replace: 'orbit.breakpoints.replace',
};
const RECORD_METHODS = {
    start: 'orbit.record.start',
    stop: 'orbit.record.stop',
    list: 'orbit.record.list',
    get: 'orbit.record.get',
    clear: 'orbit.record.clear',
};
/**
 * Resolves a command name (and its action for step/breakpoints/record) into the
 * JSON-RPC method, request context kind, and required scopes. Shared by the
 * one-shot CLI and the long-lived session router so the action fan-out stays in
 * one place.
 */
function resolveCommandSpec(command, action) {
    if (!command || command === 'instances')
        throw new index_1.OrbitClientError('instances does not dispatch RPC');
    const base = exports.CLI_COMMANDS[command];
    if (!base?.method)
        throw new index_1.OrbitClientError(`unknown command: ${command}`);
    let method = base.method;
    let context = base.context ?? 'connection';
    let scopes = [...base.scopes];
    if (command === 'step') {
        method = STEP_METHODS[action] ?? '';
        if (!method)
            throw new index_1.OrbitClientError(`unsupported step action: ${action}`);
    }
    if (command === 'breakpoints') {
        method = BREAKPOINT_METHODS[action] ?? '';
        if (!method)
            throw new index_1.OrbitClientError(`unsupported breakpoints action: ${action}`);
        if (action !== 'list') {
            context = 'connectionMutation';
            scopes = ['read', 'breakpoints.write'];
        }
    }
    if (command === 'record') {
        method = RECORD_METHODS[action] ?? '';
        if (!method)
            throw new index_1.OrbitClientError(`unsupported record action: ${action}`);
        if (['start', 'stop', 'clear'].includes(action)) {
            context = 'targetMutation';
            scopes = ['read', 'record'];
        }
    }
    return { method, context, scopes };
}
function jsonParams(parsed) {
    const raw = stringFlag(parsed, 'params');
    if (!raw)
        return {};
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new index_1.OrbitClientError('--params must be a JSON object');
    }
    return value;
}
function resolveCommand(parsed) {
    const command = parsed.command;
    if (!command)
        throw new index_1.OrbitClientError('command is required');
    const action = command === 'step'
        ? (stringFlag(parsed, 'action') ?? 'into')
        : (stringFlag(parsed, 'action') ?? parsed.positional[0] ?? 'list');
    const spec = resolveCommandSpec(command, action);
    const params = jsonParams(parsed);
    if (command === 'operation')
        params.operationId ??= parsed.positional[0];
    if (command === 'start')
        params.configurationId ??= parsed.positional[0];
    if (command === 'read' && params.expressions === undefined)
        params.expressions = parsed.positional;
    if (command === 'memory-read') {
        params.address ??= parsed.positional[0];
        if (params.count === undefined && parsed.positional[1])
            params.count = Number(parsed.positional[1]);
    }
    if (command === 'step' && params.threadId === undefined && parsed.positional[0]) {
        params.threadId = Number(parsed.positional[0]);
    }
    return { ...spec, params };
}
function publicEndpoint(endpoint) {
    const { token: _token, ...publicFields } = endpoint;
    return publicFields;
}
function usage() {
    return [
        'Usage: orbit-automation <command> [args] [--registry PATH] [--project ID] [--instance ID] [--params JSON]',
        `Commands: ${Object.keys(exports.CLI_COMMANDS).join(', ')}`,
        'Actions: step --action into|over|out|instruction; breakpoints/record --action <name>',
    ].join('\n');
}
async function runCli(argv, io = {
    stdout: value => process.stdout.write(`${value}\n`),
    stderr: value => process.stderr.write(`${value}\n`),
}) {
    const parsed = parseArguments(argv);
    if (!parsed.command || parsed.flags.has('help')) {
        io.stdout(usage());
        return parsed.command ? 0 : 2;
    }
    if (!(parsed.command in exports.CLI_COMMANDS))
        throw new index_1.OrbitClientError(`unknown command: ${parsed.command}`);
    const instances = await (0, index_1.enumerateInstances)({ registryPath: stringFlag(parsed, 'registry') });
    if (parsed.command === 'instances') {
        io.stdout(JSON.stringify(instances.map(publicEndpoint), null, 2));
        return 0;
    }
    const endpoint = (0, index_1.selectInstance)(instances, {
        projectId: stringFlag(parsed, 'project'),
        instanceId: stringFlag(parsed, 'instance'),
    });
    const command = resolveCommand(parsed);
    const extraScopes = (stringFlag(parsed, 'scopes') ?? '').split(',').filter(Boolean);
    const client = new index_1.OrbitClient(endpoint);
    await client.handshake({
        client: { name: 'orbit-automation-cli', version: '1.0.0', pid: process.pid },
        requestedScopes: [...new Set([...command.scopes, ...extraScopes])],
    });
    try {
        if (command.context === 'target' || command.context === 'targetMutation') {
            await client.refreshSession(stringFlag(parsed, 'session'));
        }
        const data = await client.invoke(command.method, command.params, {
            context: command.context,
            idempotencyKey: stringFlag(parsed, 'idempotency'),
        });
        io.stdout(JSON.stringify(data, null, 2));
        return 0;
    }
    finally {
        try {
            await client.close();
        }
        catch {
            // Best-effort lease release; never mask the command result or error.
        }
    }
}
async function main() {
    try {
        process.exitCode = await runCli(process.argv.slice(2));
    }
    catch (error) {
        if (error instanceof index_1.OrbitRpcError) {
            process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code, data: error.data })}\n`);
        }
        else {
            process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
        }
        process.exitCode = 1;
    }
}
if (require.main === module)
    void main();
//# sourceMappingURL=cli.js.map