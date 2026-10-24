const fs = require('fs');
const path = require('path');
module.exports = async ({ user, wait, control, L, events, proj }) => {
  L(`FLAG ${JSON.stringify(await control({ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } }).catch((e) => String(e)))}`);
  user('hello wt');
  await wait((e) => e.type === 'result', 40000);
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  L(`INIT cwd=${init.cwd} sid=${init.session_id} memory=${JSON.stringify(init.memory_paths)}`);
  fs.writeFileSync(path.join(__dirname, 'wt-state.json'), JSON.stringify({ sid: init.session_id, cwd: init.cwd, proj }));
  const st = await control({ subtype: 'get_settings' }).catch((e) => String(e));
  L(`SETTINGS ${JSON.stringify(st).slice(0, 600)}`);
};
