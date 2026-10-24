// 第一阶段：建立会话（写文件、编辑、子代理），记录 uuid，供下一进程分叉/回退
const fs = require('fs');
const path = require('path');
module.exports = async ({ user, wait, respond, control, proj, L, events }) => {
  const isResult = (e) => e.type === 'result';
  const canUse = (e) => e.type === 'control_request' && e.request && e.request.subtype === 'can_use_tool';
  async function step(text, uuid) {
    user(text, uuid ? { uuid } : {});
    for (;;) {
      const ev = await wait((e) => isResult(e) || canUse(e), 40000);
      if (isResult(ev)) return ev;
      if (ev.request.tool_name === 'ExitPlanMode') L(`PLANREQ ${JSON.stringify(ev.request)}`);
      respond(ev, { behavior: 'allow', updatedInput: ev.request.input });
    }
  }
  const file = `${proj.replace(/\\/g, '/')}/f.txt`;
  await step('first hello', 'aaaaaaaa-0000-4000-8000-000000000001');
  await step(`CMD:WRITE:${file}`, 'aaaaaaaa-0000-4000-8000-000000000002');
  await step(`CMD:EDIT:${file}`, 'aaaaaaaa-0000-4000-8000-000000000003');
  const sid = events.find((e) => e.type === 'system' && e.subtype === 'init').session_id;
  // 记录每条用户消息之前的最后一个链条目 uuid
  const chain = events.filter((e) => (e.type === 'assistant' || e.type === 'user') && e.uuid && !e.parent_tool_use_id).map((e) => ({ t: e.type, uuid: e.uuid, replay: !!e.isReplay, text: JSON.stringify(e.message.content).slice(0, 60) }));
  L(`CHAIN ${JSON.stringify(chain)}`);
  fs.writeFileSync(path.join(__dirname, 'fork-state.json'), JSON.stringify({ sid, file, chain, proj }));
  // 子代理
  user('CMD:AGENT');
  const r = await wait(isResult, 60000).catch(() => null);
  L(`agent result ${r && r.result}`);
  const sub = events.filter((e) => e.parent_tool_use_id);
  L(`SUBAGENT events=${sub.length} types=${[...new Set(sub.map((e) => e.type))].join(',')}`);
  for (const e of events.filter((x) => x.type === 'system' && /^task_/.test(x.subtype))) L(`TASKEV ${JSON.stringify(e).slice(0, 400)}`);
  L(`GET_PLAN ${JSON.stringify(await control({ subtype: 'get_plan' }).catch((e) => String(e))).slice(0, 400)}`);
};
