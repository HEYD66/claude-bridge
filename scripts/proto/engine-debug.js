// 只跑第一步并打印详细信息
process.env.ENGINE_DEBUG = '1';
const Module = require('module');
const origRemove = require('../../src/main/session-host').RemoteRun.prototype.remove;
require('../../src/main/session-host').RemoteRun.prototype.remove = async function () {
  console.log('[debug] remove skipped for', this.runId);
};
const orig = require('../../src/main/session-host').RemoteRun.launch;
require('../../src/main/session-host').RemoteRun.launch = async function (ssh, opts) {
  try {
    const r = await orig.call(this, ssh, opts);
    console.log('[debug] launched', opts.runId);
    return r;
  } catch (e) {
    console.log('[debug] launch error', e.message);
    throw e;
  }
};
require('./engine-test-step1.js');
