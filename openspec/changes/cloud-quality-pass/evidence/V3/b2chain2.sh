#!/usr/bin/env bash
for m in boot loop ink first-frame renders cls qa; do /tmp/v3/b2.sh $m 3; done
echo B2-DONE >> /tmp/v3/b2/ALL
