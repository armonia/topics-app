# Provider settings in one readable page

## Goal
Keep provider setup, models and connection management in one expandable list. Make advanced execution settings understandable and move MCP and tool grants to their own Tools settings section.

## Scope
Use existing Settings navigation, provider cards and design tokens. Unconnected API rows expand in place; connected rows prioritize the selected model and expose key replacement on demand in the same card. Group advanced controls by execution and local programs. MCP and tool permissions remain fully available under Tools, loaded only when visited. No runtime, model, credentials, quota, dispatch or permission changes are performed by navigation.

## Acceptance bar
Existing API onboarding, rejected-key recovery and CLI setup tests pass on desktop and phone. Browser evidence demonstrates in-place connection management, independent Tools navigation and zero MCP reads from Providers including its advanced controls. Typecheck, lint, fast static gate and the existing bundle budget remain green. Independent review checks navigation and state preservation.
