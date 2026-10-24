// 场景：Bash 权限（stdio）、AskUserQuestion、Write/Edit、TodoWrite、ExitPlanMode、上下文用量
module.exports = async ({ user, wait, respond, control, proj, L }) => {
  const isResult = (e) => e.type === 'result';
  const canUse = (e) => e.type === 'control_request' && e.request && e.request.subtype === 'can_use_tool';
  // 发送一条消息，若出现权限请求则交给 handler 处理，直到 result
  async function step(name, text, handler) {
    user(text);
    for (;;) {
      const ev = await wait((e) => isResult(e) || canUse(e), 30000);
      if (isResult(ev)) {
        L(`STEP ${name} result: ${String(ev.result).slice(0, 300)}`);
        return;
      }
      L(`PERM ${name} request=${JSON.stringify(ev.request).slice(0, 1800)}`);
      respond(ev, handler(ev.request));
    }
  }
  const file = `${proj.replace(/\\/g, '/')}/note.txt`;
  await step('bash', 'CMD:BASH:mkdir -p sub && touch sub/a.txt', (r) => ({ behavior: 'allow', updatedInput: r.input, updatedPermissions: r.permission_suggestions }));
  await step('bash2', 'CMD:BASH:mkdir -p sub && touch sub/b.txt', (r) => ({ behavior: 'allow', updatedInput: r.input }));
  await step('ask', 'CMD:ASK', (r) => ({ behavior: 'allow', updatedInput: { ...r.input, answers: { [r.input.questions[0].question]: 'Blue' } } }));
  await step('write', `CMD:WRITE:${file}`, (r) => ({ behavior: 'allow', updatedInput: r.input }));
  await step('edit-deny', `CMD:EDIT:${file}`, () => ({ behavior: 'deny', message: 'User said no' }));
  await step('todo', 'CMD:TODO', (r) => ({ behavior: 'allow', updatedInput: r.input }));
  await step('plan', 'CMD:PLAN', (r) => ({ behavior: 'allow', updatedInput: r.input }));
  const usage = await control({ subtype: 'get_context_usage', detail: 'summary' });
  L(`CONTEXT ${JSON.stringify(usage).slice(0, 3000)}`);
  const rules = await control({ subtype: 'list_permission_rules' });
  L(`RULES ${JSON.stringify(rules).slice(0, 2000)}`);
};
