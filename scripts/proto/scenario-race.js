// 复现：发送一条消息后几乎立刻用 priority:'now' 插话
module.exports = async ({ user, wait, L }) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mark = (s) => L(`---------- ${s}`);
  const isResult = (e) => e.type === 'result';
  mark('0 warm up');
  user('hello');
  await wait(isResult, 60000);

  mark('1 now-priority right after send (no gap)');
  user('CMD:SLOW first', { uuid: '11111111-1111-4111-8111-000000000001' });
  user('CMD:ECHO interject', { uuid: '11111111-1111-4111-8111-000000000002', priority: 'now' });
  await wait(isResult, 60000);
  await wait(isResult, 60000).catch(() => L('no second result'));
  await sleep(1500);

  mark('2 now-priority 300ms after send');
  user('CMD:SLOW second', { uuid: '11111111-1111-4111-8111-000000000003' });
  await sleep(300);
  user('CMD:ECHO interject2', { uuid: '11111111-1111-4111-8111-000000000004', priority: 'now' });
  await wait(isResult, 60000);
  await wait(isResult, 60000).catch(() => L('no second result'));
  await sleep(1500);
};
