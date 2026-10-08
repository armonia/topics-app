#!/usr/bin/env bash
until grep -q CHAIN-DONE /tmp/v3/chain.log 2>/dev/null; do sleep 10; done
for m in branches routes boot loop ink first-frame renders cls qa; do /tmp/v3/b2.sh $m 3; done
echo B2-DONE >> /tmp/v3/b2/ALL
