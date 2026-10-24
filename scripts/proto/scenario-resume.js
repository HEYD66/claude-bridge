module.exports = async ({ user, wait, L, events }) => {
  user('CMD:ECHO resumed?');
  const r = await wait((e) => e.type === 'result', 40000).catch(() => null);
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  L(`RESUME result=${r && String(r.result).slice(-200)} is_error=${r && r.is_error} cwd=${init && init.cwd} sid=${init && init.session_id}`);
};
