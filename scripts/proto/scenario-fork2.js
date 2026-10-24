// 第二阶段（新进程，--resume ... --resume-session-at ... --fork-session）：检查分叉后的上下文与回退
const fs = require('fs');
const path = require('path');
module.exports = async ({ user, wait, control, L, events }) => {
  const st = JSON.parse(fs.readFileSync(path.join(__dirname, 'fork-state.json'), 'utf8'));
  user('CMD:ECHO after-fork');
  const r = await wait((e) => e.type === 'result', 40000);
  L(`FORK result: ${r.result}`);
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  L(`FORK new session=${init.session_id} old=${st.sid}`);
  L(`file before rewind: ${JSON.stringify(fs.readFileSync(st.file, 'utf8'))}`);
  const dry = await control({ subtype: 'rewind_files', user_message_id: 'aaaaaaaa-0000-4000-8000-000000000003', dry_run: true }).catch((e) => String(e));
  L(`REWIND dry (resumed process) ${JSON.stringify(dry)}`);
};
