#!/bin/bash
# 在 WSL 中验证常驻运行宿主：tail -F 输入文件喂给 claude，脱离会话后仍运行，空闲看门狗，退出哨兵
# 用法：bash host-test.sh <claude可执行> <mockPort>
set -u
CLAUDE="$1"; PORT="$2"
D=$(mktemp -d /tmp/cbhost.XXXX)
mkdir -p "$D/cfg" "$D/proj"
: > "$D/in.jsonl"; : > "$D/out.jsonl"
cat > "$D/run.sh" <<EOF
#!/bin/bash
cd "$D"
echo \$\$ > pid
exec 3< <(exec tail -n +1 -F in.jsonl 2>/dev/null)
TAILPID=\$!
echo \$TAILPID > tailpid
# 空闲看门狗：最后一行是 result 且 IDLE 秒内无输入输出 → 关闭输入，claude 自然退出
( while sleep 2; do
    now=\$(date +%s); mi=\$(stat -c %Y in.jsonl); mo=\$(stat -c %Y out.jsonl)
    if [ \$((now-mi)) -ge \$IDLE ] && [ \$((now-mo)) -ge \$IDLE ] && tail -n 1 out.jsonl | grep -q '"type":"result"'; then kill \$TAILPID 2>/dev/null; break; fi
  done ) &
WD=\$!
cd proj && WSLENV=ANTHROPIC_BASE_URL:ANTHROPIC_API_KEY:CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT ANTHROPIC_API_KEY=sk-ant-api03-mock CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1 \
  "$CLAUDE" -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --permission-prompt-tool stdio <&3 >> "$D/out.jsonl" 2>> "$D/err.log"
code=\$?
echo "{\"type\":\"bridge_exit\",\"code\":\$code}" >> "$D/out.jsonl"
kill \$TAILPID \$WD 2>/dev/null
EOF
chmod +x "$D/run.sh"
IDLE=6 setsid nohup env IDLE=6 "$D/run.sh" > /dev/null 2>&1 < /dev/null &
sleep 1
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello host"}]},"parent_tool_use_id":null,"session_id":""}' >> "$D/in.jsonl"
for i in $(seq 1 30); do grep -q '"type":"result"' "$D/out.jsonl" && break; sleep 1; done
echo "RESULT1: $(grep -c '"type":"result"' "$D/out.jsonl")"
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"second msg"}]},"parent_tool_use_id":null,"session_id":""}' >> "$D/in.jsonl"
for i in $(seq 1 30); do [ "$(grep -c '"type":"result"' "$D/out.jsonl")" -ge 2 ] && break; sleep 1; done
echo "RESULT2: $(grep -c '"type":"result"' "$D/out.jsonl")"
# 等空闲看门狗关闭
for i in $(seq 1 30); do grep -q bridge_exit "$D/out.jsonl" && break; sleep 1; done
echo "EXIT LINE: $(grep bridge_exit "$D/out.jsonl")"
echo "PROCS LEFT: $(pgrep -f "$D" | wc -l)"
echo "ERR: $(head -c 300 "$D/err.log")"
grep -o '"result":"[^"]*"' "$D/out.jsonl"
rm -rf "$D"
