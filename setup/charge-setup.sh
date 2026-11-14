#!/bin/bash
# Run once through `caelestia-charge --setup`. Lets caelestia-charge (and the battery popout) change the
# charge limit without sudo: at boot a small service applies your saved limit and hands the limit file to you.
# Undo: caelestia-charge --undo   (removes the service; the limit then stays wherever the firmware keeps it)
set -e
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
U=${SUDO_USER:?run through sudo from your own account}; H=$(getent passwd "$U" | cut -d: -f6)
F=$(ls /sys/class/power_supply/*/charge_control_end_threshold 2>/dev/null | head -n 1)
[ -n "$F" ] || { echo "This computer has no battery charge limit." >&2; exit 1; }
S=/etc/systemd/system/caelestia-battery-limit.service
if [ "${1:-}" = --undo ]; then
    systemctl disable --now caelestia-battery-limit.service 2>/dev/null || true
    rm -f "$S"
    systemctl daemon-reload
    chown root "$F"
    echo "removed"
    exit 0
fi
cat > "$S" <<EOF
[Unit]
Description=Battery charge limit from $H/.config/caelestia-gnome/charge-limit (default 80), owned by $U
After=local-fs.target
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'L=\$(head -c 4 $H/.config/caelestia-gnome/charge-limit 2>/dev/null | tr -cd 0-9); case "\$L" in 60|70|80|90|100) ;; *) L=80;; esac; echo \$L > $F; chown $U $F'
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable caelestia-battery-limit.service
systemctl restart caelestia-battery-limit.service
echo "done: $(cat "$F")% limit, file owner $(stat -c %U "$F")"
