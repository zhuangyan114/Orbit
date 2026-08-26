'use strict';

// P7-3: STM32H723VGT6 Flash Algorithm Init/UnInit only. No erase/program.
// Usage: node scripts/cmsis-dap/verify-h723-algorithm-init-hw.js --hardware --authorize-algorithm-init

const {
  H723,
  requireHardware,
  requireAuthorize,
  refuseSecondOwner,
  loadH723Algorithm,
  flashAlgorithmParams,
  createEvidence,
  createHelperSession,
  connectSwd,
  disconnectSession,
  finish,
} = require('./h723-hw-harness');

const SCRIPT = 'verify-h723-algorithm-init-hw';
requireHardware(SCRIPT);
requireAuthorize(SCRIPT, '--authorize-algorithm-init', ['halt', 'Flash Algorithm Init', 'Flash Algorithm UnInit']);
refuseSecondOwner(SCRIPT);

const evidence = createEvidence('Orbit H723 P7-3 algorithm Init/UnInit hardware verification v1', {
  grantedByUser: true,
  authorizedOperations: ['halt', 'Flash Algorithm Init', 'Flash Algorithm UnInit'],
  forbiddenOperations: ['erase', 'program', 'verify', 'option bytes', 'second owner'],
});

async function run(session) {
  if (!await connectSwd(session, evidence)) return;
  const halt = await session.request('halt', { timeoutMs: 2000 }, 10000);
  session.check('halt target before algorithm', halt.ok && halt.targetState === 'Halted', halt);
  if (!halt.ok) return;
  const algorithm = loadH723Algorithm();
  evidence.summary.algorithmPath = algorithm.path;
  evidence.summary.algorithmBytes = algorithm.code.length;
  const init = await session.request(
    'flashAlgorithm',
    flashAlgorithmParams(algorithm, 'init', H723.flashBase, 0),
    H723.initTimeoutMs + 10000,
  );
  session.check('algorithm Init returnCode=0 at BKPT', init.ok
    && init.data && init.data.returnCode === 0
    && init.data.pc === algorithm.algorithmAddress + algorithm.entries.bkpt, init);
  const uninit = await session.request(
    'flashAlgorithm',
    flashAlgorithmParams(algorithm, 'uninit', H723.flashBase, 0),
    H723.initTimeoutMs + 10000,
  );
  session.check('algorithm UnInit returnCode=0 at BKPT', uninit.ok
    && uninit.data && uninit.data.returnCode === 0
    && uninit.data.pc === algorithm.algorithmAddress + algorithm.entries.bkpt, uninit);
}

async function main() {
  const session = createHelperSession(evidence);
  let runFailed = false;
  try {
    await run(session);
  } catch (error) {
    runFailed = true;
    console.error(`${SCRIPT}: ${error.message}`);
  } finally {
    await disconnectSession(session).catch(() => {});
    await finish(SCRIPT, evidence, session, runFailed, 'h723-p7');
  }
}

main();
