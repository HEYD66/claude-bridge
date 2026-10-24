module.exports = async ({ user, send, wait, respond, control, proj, L, events }) => {
  const isResult = (e) => e.type === 'result';
  const canUse = (e) => e.type === 'control_request' && e.request && e.request.subtype === 'can_use_tool';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mark = (s) => L(`---------- ${s}`);

  mark('1 queue: send while slow reply streaming');
  user('CMD:SLOW first');
  await sleep(1500);
  user('CMD:ECHO second-queued', { uuid: '11111111-aaaa-4aaa-8aaa-111111111111' });
  await wait(isResult, 40000);
  L('first result done');
  await wait(isResult, 40000);
  L('second result done');

  mark('2 priority now while slow');
  user('CMD:SLOW third');
  await sleep(1500);
  user('CMD:ECHO fourth-now', { priority: 'now' });
  await wait(isResult, 40000);
  await wait(isResult, 40000).catch(() => L('no second result for now-priority'));

  mark('3 interrupt');
  user('CMD:SLOW to-interrupt');
  await sleep(1500);
  const ir = await control({ subtype: 'interrupt' });
  L(`INTERRUPT resp ${JSON.stringify(ir)}`);
  const r3 = await wait(isResult, 20000);
  L(`after interrupt result subtype=${r3.subtype} is_error=${r3.is_error}`);

  mark('4 checkpoint + rewind');
  const file = `${proj.replace(/\\/g, '/')}/ck.txt`;
  user(`CMD:WRITE:${file}`, { uuid: '22222222-bbbb-4bbb-8bbb-222222222222' });
  for (;;) {
    const ev = await wait((e) => isResult(e) || canUse(e));
    if (isResult(ev)) break;
    respond(ev, { behavior: 'allow', updatedInput: ev.request.input });
  }
  user(`CMD:EDIT:${file}`, { uuid: '33333333-cccc-4ccc-8ccc-333333333333' });
  for (;;) {
    const ev = await wait((e) => isResult(e) || canUse(e));
    if (isResult(ev)) break;
    respond(ev, { behavior: 'allow', updatedInput: ev.request.input });
  }
  const fs = require('fs');
  L(`file after edit: ${JSON.stringify(fs.readFileSync(file, 'utf8'))}`);
  const dry = await control({ subtype: 'rewind_files', user_message_id: '33333333-cccc-4ccc-8ccc-333333333333', dry_run: true });
  L(`REWIND dry ${JSON.stringify(dry)}`);
  const rw = await control({ subtype: 'rewind_files', user_message_id: '33333333-cccc-4ccc-8ccc-333333333333' });
  L(`REWIND ${JSON.stringify(rw)}`);
  L(`file after rewind: ${fs.existsSync(file) ? JSON.stringify(fs.readFileSync(file, 'utf8')) : 'MISSING'}`);

  mark('5 image');
  send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'CMD:ECHO look at image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } }] }, parent_tool_use_id: null, session_id: '' });
  const r5 = await wait(isResult);
  L(`image result: ${r5.result}`);

  mark('6 set_model + set_permission_mode plan');
  L(`SET_MODEL ${JSON.stringify(await control({ subtype: 'set_model', model: 'haiku' }))}`);
  L(`SET_MODE ${JSON.stringify(await control({ subtype: 'set_permission_mode', mode: 'plan' }))}`);
  user('CMD:PLAN');
  for (;;) {
    const ev = await wait((e) => isResult(e) || canUse(e));
    if (isResult(ev)) {
      L(`plan result: ${ev.result}`);
      break;
    }
    L(`PERM plan request=${JSON.stringify(ev.request).slice(0, 1500)}`);
    respond(ev, { behavior: 'allow', updatedInput: ev.request.input });
  }
  L(`assistant model last: ${[...events].reverse().find((e) => e.type === 'assistant').message.model}`);

  mark('7 usage + cost');
  L(`USAGE ${JSON.stringify(await control({ subtype: 'get_usage', skip_behaviors: true }).catch((e) => String(e))).slice(0, 1500)}`);
  L(`COST ${JSON.stringify(await control({ subtype: 'get_session_cost' }).catch((e) => String(e))).slice(0, 800)}`);
  const kinds = {};
  for (const e of events) kinds[`${e.type}/${e.subtype || ''}`] = (kinds[`${e.type}/${e.subtype || ''}`] || 0) + 1;
  L(`KINDS ${JSON.stringify(kinds)}`);
};
