#!/bin/bash
# tavern-link 机器人实时日志
clear
echo "==== tavern-link 机器人实时日志（Ctrl+C 退出，不影响运行）===="
echo "==== 常用操作 ===="
echo "  重启机器人:  launchctl kickstart -k gui/501/com.dupingguo.tavern-link"
echo "  看QQ协议端:  docker logs napcat --tail 20 -f"
echo ""
tail -f /tmp/tavern-link.log
