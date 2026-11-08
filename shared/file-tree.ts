/**
 * A node of the tree `GET /api/files` returns (`server/lib/file-tree.ts`), read
 * by the file explorer and the @-mention menu. One declaration for both sides
 * (`tests/unit/no-type-mirrors.test.ts`).
 */
export interface FileNode { name: string; type: "file" | "dir"; path: string; size?: number; modified?: string; children?: FileNode[]; }
