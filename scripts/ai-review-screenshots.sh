#!/bin/bash
# AI-powered visual review of E2E test screenshots using Claude Sonnet
set -euo pipefail

PROJECT_DIR="${1:-.}"
RESULTS_DIR="$PROJECT_DIR/test-results"
OUTPUT_FILE="$RESULTS_DIR/ai-review.json"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

# Check for screenshots
SCREENSHOTS=($(find "$RESULTS_DIR" -maxdepth 1 -name '*.png' 2>/dev/null | sort))
if [ ${#SCREENSHOTS[@]} -eq 0 ]; then
  echo -e "${YELLOW}No screenshots found in $RESULTS_DIR${NC}"
  echo '{"screenshots":[],"summary":{"total":0,"pass":0,"review":0,"fail":0}}' > "$OUTPUT_FILE"
  exit 0
fi

# Get API key
API_KEY=$(python3 -c "
import json, os
try:
    d = json.load(open(os.path.expanduser('~/.openclaw/agents/main/agent/auth-profiles.json')))
    print([p['token'] for p in d['profiles'] if p.get('provider') == 'anthropic'][0])
except Exception as e:
    print('')
" 2>/dev/null)

if [ -z "$API_KEY" ]; then
  echo -e "${RED}ERROR: Could not read Anthropic API key from auth-profiles.json${NC}"
  exit 1
fi

SINGLE_PROMPT='Analyze this UI screenshot from an E2E test of a desktop app called "Topics" (a chat/IDE hybrid app with sidebar, panels, and chat).

Check for:
1. Layout issues: misalignment, overlap, truncated text, inconsistent padding
2. Visual bugs: wrong colors, flash artifacts, elements that look broken
3. State issues: "Offline" when should be connected, loading spinners stuck, empty states that should not be empty
4. UX problems: text too small, contrast issues, clickable elements that do not look clickable

Reply with JSON only (no markdown fences):
{"issues": [{"severity": "error|warning|info", "description": "...", "location": "top-left|center|sidebar|etc"}], "overall": "pass|review|fail", "summary": "one line summary"}

If everything looks good, return {"issues": [], "overall": "pass", "summary": "UI looks correct"}'

PAIR_PROMPT='Analyze these BEFORE and AFTER UI screenshots from an E2E test of a desktop app called "Topics" (a chat/IDE hybrid app with sidebar, panels, and chat).

Check for:
1. Layout issues: misalignment, overlap, truncated text, inconsistent padding
2. Visual bugs: wrong colors, flash artifacts, elements that look broken
3. State issues: "Offline" when should be connected, loading spinners stuck, empty states that should not be empty
4. UX problems: text too small, contrast issues, clickable elements that do not look clickable
5. Unexpected changes between the two states
6. Layout shift (elements moved that should not have)
7. Content that disappeared or appeared unexpectedly

Reply with JSON only (no markdown fences):
{"issues": [{"severity": "error|warning|info", "description": "...", "location": "top-left|center|sidebar|etc"}], "overall": "pass|review|fail", "summary": "one line summary"}

If everything looks good, return {"issues": [], "overall": "pass", "summary": "UI looks correct"}'

echo -e "${BLUE}═══════════════════════════════════════════${NC}"
echo -e "${BLUE}  AI Visual Review - ${#SCREENSHOTS[@]} screenshots${NC}"
echo -e "${BLUE}═══════════════════════════════════════════${NC}"
echo ""

# Group BEFORE/AFTER pairs
declare -A PAIRS
declare -a SINGLES
for img in "${SCREENSHOTS[@]}"; do
  base=$(basename "$img" .png)
  if [[ "$base" == *-BEFORE-* ]]; then
    key="${base/-BEFORE-/-}"
    PAIRS["$key"]="before:$img"
  elif [[ "$base" == *-AFTER-* ]]; then
    key="${base/-AFTER-/-}"
    if [ -n "${PAIRS[$key]+x}" ]; then
      PAIRS["$key"]="${PAIRS[$key]}|after:$img"
    else
      PAIRS["$key"]="after:$img"
    fi
  else
    SINGLES+=("$img")
  fi
done

RESULTS='[]'
PASS=0; REVIEW=0; FAIL=0

review_single() {
  local img="$1"
  local name=$(basename "$img" .png)
  echo -ne "  Reviewing ${BLUE}$name${NC}... "

  local IMG_B64=$(base64 -i "$img")
  local ESCAPED_PROMPT=$(echo "$SINGLE_PROMPT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" | sed 's/^"//;s/"$//')

  local RESPONSE=$(curl -s https://api.anthropic.com/v1/messages \
    -H "x-api-key: $API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d "{
      \"model\": \"claude-sonnet-4-6\",
      \"max_tokens\": 1024,
      \"messages\": [{
        \"role\": \"user\",
        \"content\": [
          {\"type\": \"image\", \"source\": {\"type\": \"base64\", \"media_type\": \"image/png\", \"data\": \"$IMG_B64\"}},
          {\"type\": \"text\", \"text\": \"$ESCAPED_PROMPT\"}
        ]
      }]
    }" 2>/dev/null)

  local AI_TEXT=$(echo "$RESPONSE" | python3 -c "
import sys,json,re
try:
    d=json.loads(sys.stdin.read())
    t=d['content'][0]['text']
    # Strip markdown fences if present
    t=re.sub(r'^\`\`\`json?\s*','',t.strip())
    t=re.sub(r'\`\`\`\s*$','',t.strip())
    json.loads(t)  # validate
    print(t)
except Exception as e:
    print(json.dumps({'issues':[],'overall':'review','summary':'API error: '+str(e)}))
" 2>/dev/null)

  local OVERALL=$(echo "$AI_TEXT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('overall','review'))")
  local SUMMARY=$(echo "$AI_TEXT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('summary',''))")

  case "$OVERALL" in
    pass)   echo -e "${GREEN}✓ PASS${NC} - $SUMMARY"; ((PASS++)) || true ;;
    review) echo -e "${YELLOW}⚠ REVIEW${NC} - $SUMMARY"; ((REVIEW++)) || true ;;
    fail)   echo -e "${RED}✗ FAIL${NC} - $SUMMARY"; ((FAIL++)) || true ;;
  esac

  RESULTS=$(echo "$RESULTS" | python3 -c "
import sys,json
arr=json.loads(sys.stdin.read())
arr.append({'screenshot':'$name','type':'single','file':'$(basename "$img")','review':$AI_TEXT})
print(json.dumps(arr))
")
}

review_pair() {
  local key="$1"
  local before_img="$2"
  local after_img="$3"
  echo -ne "  Reviewing pair ${BLUE}$key${NC}... "

  local B_B64=$(base64 -i "$before_img")
  local A_B64=$(base64 -i "$after_img")
  local ESCAPED_PROMPT=$(echo "$PAIR_PROMPT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" | sed 's/^"//;s/"$//')

  local RESPONSE=$(curl -s https://api.anthropic.com/v1/messages \
    -H "x-api-key: $API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d "{
      \"model\": \"claude-sonnet-4-6\",
      \"max_tokens\": 1024,
      \"messages\": [{
        \"role\": \"user\",
        \"content\": [
          {\"type\": \"image\", \"source\": {\"type\": \"base64\", \"media_type\": \"image/png\", \"data\": \"$B_B64\"}},
          {\"type\": \"image\", \"source\": {\"type\": \"base64\", \"media_type\": \"image/png\", \"data\": \"$A_B64\"}},
          {\"type\": \"text\", \"text\": \"First image is BEFORE, second is AFTER. $ESCAPED_PROMPT\"}
        ]
      }]
    }" 2>/dev/null)

  local AI_TEXT=$(echo "$RESPONSE" | python3 -c "
import sys,json,re
try:
    d=json.loads(sys.stdin.read())
    t=d['content'][0]['text']
    t=re.sub(r'^\`\`\`json?\s*','',t.strip())
    t=re.sub(r'\`\`\`\s*$','',t.strip())
    json.loads(t)
    print(t)
except Exception as e:
    print(json.dumps({'issues':[],'overall':'review','summary':'API error: '+str(e)}))
" 2>/dev/null)

  local OVERALL=$(echo "$AI_TEXT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('overall','review'))")
  local SUMMARY=$(echo "$AI_TEXT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('summary',''))")

  case "$OVERALL" in
    pass)   echo -e "${GREEN}✓ PASS${NC} - $SUMMARY"; ((PASS++)) || true ;;
    review) echo -e "${YELLOW}⚠ REVIEW${NC} - $SUMMARY"; ((REVIEW++)) || true ;;
    fail)   echo -e "${RED}✗ FAIL${NC} - $SUMMARY"; ((FAIL++)) || true ;;
  esac

  RESULTS=$(echo "$RESULTS" | python3 -c "
import sys,json
arr=json.loads(sys.stdin.read())
arr.append({'screenshot':'$key','type':'pair','before':'$(basename "$before_img")','after':'$(basename "$after_img")','review':$AI_TEXT})
print(json.dumps(arr))
")
}

# Process pairs
for key in "${!PAIRS[@]}"; do
  IFS='|' read -ra parts <<< "${PAIRS[$key]}"
  before=""; after=""
  for part in "${parts[@]}"; do
    if [[ "$part" == before:* ]]; then before="${part#before:}"; fi
    if [[ "$part" == after:* ]]; then after="${part#after:}"; fi
  done
  if [ -n "$before" ] && [ -n "$after" ]; then
    review_pair "$key" "$before" "$after"
  elif [ -n "$before" ]; then
    review_single "$before"
  elif [ -n "$after" ]; then
    review_single "$after"
  fi
done

# Process singles
for img in "${SINGLES[@]}"; do
  review_single "$img"
done

TOTAL=$((PASS + REVIEW + FAIL))

# Write JSON output
python3 -c "
import json
results = json.loads('''$RESULTS''')
output = {
    'screenshots': results,
    'summary': {'total': $TOTAL, 'pass': $PASS, 'review': $REVIEW, 'fail': $FAIL}
}
with open('$OUTPUT_FILE', 'w') as f:
    json.dump(output, f, indent=2)
"

# Print summary
echo ""
echo -e "${BLUE}═══════════════════════════════════════════${NC}"
echo -e "  Total: $TOTAL | ${GREEN}Pass: $PASS${NC} | ${YELLOW}Review: $REVIEW${NC} | ${RED}Fail: $FAIL${NC}"
echo -e "${BLUE}═══════════════════════════════════════════${NC}"
echo -e "  Results saved to ${BLUE}$OUTPUT_FILE${NC}"

# Exit code based on results
if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
