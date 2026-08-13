#!/bin/bash
# Spike A · 步骤4 — macOS sandbox-exec 隔离 + 逃逸矩阵
set -u
BASE="/Volumes/SN350-1T/dev/agentany/spikes/spike-a/sandbox-wd"
WD="$BASE/work"
OUTSIDE="$BASE/outside"   # work 的兄弟目录 = workdir 之外
rm -rf "$BASE"; mkdir -p "$WD" "$OUTSIDE"

# 在 workdir 内预置指向外面的 symlink + hardlink（逃逸载体）
echo "SECRET-from-outside" > "$OUTSIDE/secret.txt"
ln -s "$OUTSIDE/secret.txt" "$WD/leak-symlink.txt" 2>/dev/null
ln "$OUTSIDE/secret.txt" "$WD/leak-hardlink.txt" 2>/dev/null

# profile：写只允许 workdir 内（subpath 用 realpath 规范路径！/tmp→/private/tmp）；读放开（macOS 读域弱）
WD_REAL=$(realpath "$WD")
PROFILE="$BASE/profile.sb"
cat > "$PROFILE" <<EOF
(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow file-read*)
(allow file-write* (subpath "$WD_REAL"))
(allow file-write* (path "/dev/null") (vnode-type CHARACTER-DEVICE))
EOF

sbx() { sandbox-exec -f "$PROFILE" bash -c "$1" >/tmp/sbx-out 2>/tmp/sbx-err; local rc=$?; return $rc; }
chk() { local label="$1" exp="$2" rc="$3"; if [ $rc -eq 0 ]; then echo "[$label] ALLOWED $([ "$exp" = blocked ] && echo '← ❌ 逃逸!' || echo '← ✓ 符合预期')"; else echo "[$label] BLOCKED $([ "$exp" = ok ] && echo '← ❌ 意外阻断' || echo '← ✓ 符合预期')"; fi; }

echo "=== ESCAPE MATRIX (macOS sandbox-exec) ==="
sbx "echo hi > $WD/inside.txt";                                  chk "1 write INSIDE"        ok      $?
sbx "echo pwn > $OUTSIDE/pwn.txt";                               chk "2 write OUTSIDE"       blocked $?
sbx "echo pwn > $WD/../../../escape-dotdot.txt";                 chk "3 write via ../../"    blocked $?
sbx "echo pwn > /tmp/spike-escape-abs.txt";                     chk "4 write abs /tmp"      blocked $?
sbx "cat $WD/leak-symlink.txt";                                  chk "5 read symlink-out"    "weak"  $?   # 读域弱，预期 ALLOWED
sbx "echo pwn2 > $WD/leak-hardlink.txt";                         chk "6 write hardlink-out"  escape  $?   # 已知两种机制都逃，需清洗器
sbx "cd / && echo pwn > /tmp/spike-cd-escape.txt";               chk "7 cd / && write"       blocked $?
echo "=== done ==="
