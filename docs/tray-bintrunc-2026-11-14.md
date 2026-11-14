# Tray text-truncation: O(n) loop replaced with binary search

**Date:** 2026-11-14
**Component:** macOS status-bar tray (ClaudeUsage.swift, tools/usage-hub)

## Problem

`fitLine()` and `unitItem()` truncated strings by trimming one character at
a time, calling `NSString.size(withAttributes:)` after every removal.
With 15 process rows in the submenu, `fill()` blocked the main thread for
up to 477 ms, which the live-measurement tool reported as a "menu" phase
block exceeding the 250 ms threshold.

## Fix

Introduced `binTrunc(_:maxWidth:attrs:)`: binary search over the character
array to find the longest prefix that fits within the target width, then
appends an ellipsis. Number of `size()` calls: O(log n) instead of O(n).

Both `fitLine()` and `unitItem()` now delegate to `binTrunc()`.

## Result

Bench after the fix (10 iterations, load 12 cores):

| Metric | Before | After | Threshold |
|---|---|---|---|
| Apertura median | ~200 ms | 18 ms | 150 ms |
| Submenu fill | 477 ms | 4 ms | 50 ms |
| Hover blocks | present | 0 | 0 |

Exit code: 0 (all metrics under threshold).

## Pattern

Binary search is the right tool whenever the truncation target is a
monotone predicate on a prefix length: "does the prefix fit?" is false
for all prefixes longer than the answer and true for all shorter ones.
The same pattern applies to any NSAttributedString or NSString width
constraint in a macOS menu or popover.
