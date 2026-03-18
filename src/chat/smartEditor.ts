import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import diff_match_patch from 'diff-match-patch';

const DiffMatchPatch = diff_match_patch;

export type EditIntent = 'modify' | 'rewrite' | 'refactor' | 'create' | 'auto';

export interface SmartEditResult {
    success: boolean;
    editType: 'full' | 'partial' | 'diff' | 'range' | 'create';
    changesCount: number;
    message: string;
    originalContent?: string;
    newContent?: string;
    editRanges?: vscode.Range[];
}

export interface DiffHunk {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
    oldContent: string;
    newContent: string;
}

export class SmartEditor {
    private static readonly MAX_DIFF_HUNKS = 100;
    private static dmpInstance: InstanceType<typeof DiffMatchPatch>;

    private static getDmp(): InstanceType<typeof DiffMatchPatch> {
        if (!this.dmpInstance) {
            this.dmpInstance = new DiffMatchPatch();
            this.dmpInstance.Diff_Timeout = 5;
            this.dmpInstance.Diff_EditCost = 4;
        }
        return this.dmpInstance;
    }

    static async applySmartEdit(
        uri: vscode.Uri,
        newContent: string,
        backupMap: Map<string, string | null>,
        options: {
            intent?: EditIntent;
            showPreview?: boolean;
        } = {}
    ): Promise<SmartEditResult> {
        const { intent = 'auto', showPreview = false } = options;

        let document: vscode.TextDocument | undefined;
        let fileExists = true;
        let currentContent = '';

        try {
            document = await vscode.workspace.openTextDocument(uri);
            currentContent = document.getText();
        } catch {
            fileExists = false;
        }

        if (!fileExists || intent === 'create') {
            return await this.createNewFile(uri, newContent, backupMap);
        }

        if (!document) {
            return await this.createNewFile(uri, newContent, backupMap);
        }

        // 如果当前文件内容与新内容完全相同，说明已经应用过了，直接返回
        // 比较前规范化换行符，避免因换行符差异导致误判
        const normalizeNewlines = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (normalizeNewlines(currentContent) === normalizeNewlines(newContent)) {
            return {
                success: true,
                editType: 'full',
                changesCount: 0,
                message: '文件内容无变化（已是最新状态）',
                originalContent: currentContent,
                newContent
            };
        }

        // 备份应该在 handleFileChange 中设置，这里只是确保有备份
        // 备份保存的是第一次修改前的原始内容，用于回滚
        // 但应用修改时应该基于当前文件内容（可能已经被修改过）进行diff
        if (!backupMap.has(uri.fsPath)) {
            backupMap.set(uri.fsPath, currentContent);
        }

        // originalContent 用于diff对比显示，但实际应用时使用 currentContent
        const originalContent = backupMap.get(uri.fsPath) ?? currentContent;

        switch (intent) {
            case 'modify':
                return await this.applyPartialEdit(document, currentContent, newContent);
            case 'rewrite':
            case 'refactor':
                return await this.applyFullReplace(document, newContent);
            case 'auto':
            default:
                return await this.applyAutoEdit(document, currentContent, newContent);
        }
    }

    private static async applyAutoEdit(
        document: vscode.TextDocument,
        originalContent: string,
        newContent: string
    ): Promise<SmartEditResult> {
        // 只跑一次 diff_main，复用结果同时计算相似度和 hunks
        const hunks = this.computeDiffHunks(originalContent, newContent);
        const similarity = this.calculateSimilarityFromHunks(originalContent, newContent, hunks);

        if (similarity >= 0.5) {
            if (hunks.length === 0) {
                return {
                    success: true,
                    editType: 'full',
                    changesCount: 0,
                    message: '文件内容无变化',
                    originalContent,
                    newContent
                };
            }
            if (hunks.length > this.MAX_DIFF_HUNKS) {
                return await this.applyFullReplace(document, newContent);
            }
            return await this.applyPartialEdits(document, hunks, originalContent, newContent);
        }

        return await this.applyFullReplace(document, newContent);
    }

    // 从已有 hunks 推导相似度，避免重复跑 diff_main
    static calculateSimilarityFromHunks(oldContent: string, newContent: string, hunks: DiffHunk[]): number {
        if (oldContent === newContent) { return 1; }
        if (!oldContent || !newContent) { return 0; }
        const maxLength = Math.max(oldContent.length, newContent.length);
        if (maxLength === 0) { return 0; }
        const changedLength = hunks.reduce((sum, h) => sum + Math.max(h.oldContent.length, h.newContent.length), 0);
        return Math.max(0, 1 - changedLength / maxLength);
    }

    private static async applyPartialEdit(
        document: vscode.TextDocument,
        originalContent: string,
        newContent: string
    ): Promise<SmartEditResult> {
        const hunks = this.computeDiffHunks(originalContent, newContent);
        
        if (hunks.length === 0) {
            return {
                success: true,
                editType: 'full',
                changesCount: 0,
                message: '文件内容无变化',
                originalContent,
                newContent
            };
        }

        if (hunks.length > this.MAX_DIFF_HUNKS) {
            return await this.applyFullReplace(document, newContent);
        }

        return await this.applyPartialEdits(document, hunks, originalContent, newContent);
    }

    private static async createNewFile(
        uri: vscode.Uri,
        content: string,
        backupMap: Map<string, string | null>
    ): Promise<SmartEditResult> {
        const dirPath = path.dirname(uri.fsPath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        backupMap.set(uri.fsPath, null);

        const edit = new vscode.WorkspaceEdit();
        edit.createFile(uri, { ignoreIfExists: true });
        edit.insert(uri, new vscode.Position(0, 0), content);
        await vscode.workspace.applyEdit(edit);

        const doc = await vscode.workspace.openTextDocument(uri);
        await doc.save();
        await vscode.window.showTextDocument(doc, { preview: false });

        return {
            success: true,
            editType: 'create',
            changesCount: 1,
            message: `文件已创建: ${path.basename(uri.fsPath)}`,
            newContent: content
        };
    }

    private static async applyFullReplace(
        document: vscode.TextDocument,
        newContent: string
    ): Promise<SmartEditResult> {
        const originalContent = document.getText();
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(originalContent.length)
        );
        edit.replace(document.uri, fullRange, newContent);
        await vscode.workspace.applyEdit(edit);
        await document.save();

        const newFullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(newContent.length)
        );

        return {
            success: true,
            editType: 'full',
            changesCount: 1,
            message: `文件已完整替换`,
            originalContent,
            newContent,
            editRanges: [newFullRange]
        };
    }

    private static async applyPartialEdits(
        document: vscode.TextDocument,
        hunks: DiffHunk[],
        originalContent: string,
        newContent: string
    ): Promise<SmartEditResult> {
        const edit = new vscode.WorkspaceEdit();
        let appliedHunks = 0;

        const sortedHunks = [...hunks].sort((a, b) => b.oldStart - a.oldStart);
        const appliedRanges: vscode.Range[] = [];

        for (const hunk of sortedHunks) {
            const startPos = document.positionAt(hunk.oldStart);
            const endPos = document.positionAt(hunk.oldEnd);
            const range = new vscode.Range(startPos, endPos);

            if (hunk.oldStart === hunk.oldEnd && hunk.newContent.length > 0) {
                edit.insert(document.uri, startPos, hunk.newContent);
                const insertEndPos = document.positionAt(hunk.oldStart + hunk.newContent.length);
                appliedRanges.push(new vscode.Range(startPos, insertEndPos));
            } else if (hunk.newContent.length === 0 && hunk.oldStart !== hunk.oldEnd) {
                edit.delete(document.uri, range);
            } else {
                edit.replace(document.uri, range, hunk.newContent);
                const newEndPos = document.positionAt(hunk.newStart + hunk.newContent.length);
                appliedRanges.push(new vscode.Range(startPos, newEndPos));
            }
            appliedHunks++;
        }

        const success = await vscode.workspace.applyEdit(edit);
        await document.save();

        return {
            success,
            editType: 'partial',
            changesCount: appliedHunks,
            message: `已应用 ${appliedHunks} 处局部修改`,
            originalContent,
            newContent,
            editRanges: appliedRanges
        };
    }

    static calculateSimilarity(oldContent: string, newContent: string): number {
        if (oldContent === newContent) { return 1; }
        if (!oldContent || !newContent) { return 0; }

        const dmp = this.getDmp();
        const diffs = dmp.diff_main(oldContent, newContent);
        dmp.diff_cleanupSemantic(diffs);

        let commonLength = 0;
        const DIFF_EQUAL = 0;
        
        for (const [op, text] of diffs) {
            if (op === DIFF_EQUAL) {
                commonLength += text.length;
            }
        }

        const maxLength = Math.max(oldContent.length, newContent.length);
        return maxLength > 0 ? commonLength / maxLength : 0;
    }

    static computeDiffHunks(oldContent: string, newContent: string): DiffHunk[] {
        const dmp = this.getDmp();
        const diffs = dmp.diff_main(oldContent, newContent);
        dmp.diff_cleanupSemantic(diffs);

        const DIFF_EQUAL = 0;
        const DIFF_DELETE = -1;
        const DIFF_INSERT = 1;

        const hunks: DiffHunk[] = [];
        let oldPos = 0;
        let newPos = 0;
        let i = 0;

        while (i < diffs.length) {
            const [op, text] = diffs[i];

            if (op === DIFF_EQUAL) {
                oldPos += text.length;
                newPos += text.length;
                i++;
                continue;
            }

            const hunk: DiffHunk = {
                oldStart: oldPos,
                oldEnd: oldPos,
                newStart: newPos,
                newEnd: newPos,
                oldContent: '',
                newContent: ''
            };

            while (i < diffs.length && diffs[i][0] !== DIFF_EQUAL) {
                const [currentOp, currentText] = diffs[i];

                if (currentOp === DIFF_DELETE) {
                    hunk.oldContent += currentText;
                    hunk.oldEnd += currentText.length;
                    oldPos += currentText.length;
                } else if (currentOp === DIFF_INSERT) {
                    hunk.newContent += currentText;
                    hunk.newEnd += currentText.length;
                    newPos += currentText.length;
                }

                i++;
            }

            hunks.push(hunk);
        }

        return this.mergeAdjacentHunks(hunks, oldContent);
    }

    private static mergeAdjacentHunks(hunks: DiffHunk[], oldContent: string): DiffHunk[] {
        if (hunks.length <= 1) { return hunks; }

        const merged: DiffHunk[] = [];
        const MERGE_THRESHOLD = 50;

        for (const hunk of hunks) {
            if (merged.length === 0) {
                merged.push({ ...hunk });
                continue;
            }

            const last = merged[merged.length - 1];
            const gap = hunk.oldStart - last.oldEnd;

            if (gap <= MERGE_THRESHOLD) {
                const gapContent = oldContent.substring(last.oldEnd, hunk.oldStart);
                last.oldEnd = hunk.oldEnd;
                last.newEnd = hunk.newEnd;
                last.oldContent += gapContent + hunk.oldContent;
                last.newContent += gapContent + hunk.newContent;
            } else {
                merged.push({ ...hunk });
            }
        }

        return merged;
    }

    static generateUnifiedDiff(
        oldContent: string,
        newContent: string,
        filename: string = 'file',
        contextLines: number = 3
    ): string {
        const dmp = this.getDmp();
        const patches = dmp.patch_make(oldContent, newContent);
        return dmp.patch_toText(patches);
    }

    static generateLineDiff(
        oldContent: string,
        newContent: string,
        contextLines: number = 3
    ): string {
        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');
        const result: string[] = [];

        const lcs = this.computeLCS(oldLines, newLines);
        let oldIdx = 0;
        let newIdx = 0;

        for (const commonLine of lcs) {
            while (oldIdx < oldLines.length && oldLines[oldIdx] !== commonLine) {
                result.push(`- ${oldLines[oldIdx]}`);
                oldIdx++;
            }
            while (newIdx < newLines.length && newLines[newIdx] !== commonLine) {
                result.push(`+ ${newLines[newIdx]}`);
                newIdx++;
            }
            result.push(`  ${commonLine}`);
            oldIdx++;
            newIdx++;
        }

        while (oldIdx < oldLines.length) {
            result.push(`- ${oldLines[oldIdx]}`);
            oldIdx++;
        }
        while (newIdx < newLines.length) {
            result.push(`+ ${newLines[newIdx]}`);
            newIdx++;
        }

        return result.join('\n');
    }

    private static computeLCS(a: string[], b: string[]): string[] {
        const m = a.length;
        const n = b.length;
        const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (a[i - 1] === b[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }

        const lcs: string[] = [];
        let i = m, j = n;
        while (i > 0 && j > 0) {
            if (a[i - 1] === b[j - 1]) {
                lcs.unshift(a[i - 1]);
                i--;
                j--;
            } else if (dp[i - 1][j] > dp[i][j - 1]) {
                i--;
            } else {
                j--;
            }
        }

        return lcs;
    }

    static async applySearchReplace(
        document: vscode.TextDocument,
        searchContent: string,
        replaceContent: string,
        options: { global?: boolean; caseSensitive?: boolean } = {}
    ): Promise<SmartEditResult> {
        const { global = false, caseSensitive = true } = options;
        const fullText = document.getText();
        const originalContent = fullText;

        const searchPattern = caseSensitive ? searchContent : searchContent.toLowerCase();
        const searchText = caseSensitive ? fullText : fullText.toLowerCase();

        if (!searchText.includes(searchPattern)) {
            return {
                success: false,
                editType: 'range',
                changesCount: 0,
                message: `未找到要替换的内容`,
                originalContent
            };
        }

        const edit = new vscode.WorkspaceEdit();

        if (global) {
            let lastIndex = 0;
            let changesCount = 0;
            const positions: { start: number; end: number }[] = [];

            while (true) {
                const idx = searchText.indexOf(searchPattern, lastIndex);
                if (idx === -1) { break; }
                positions.push({ start: idx, end: idx + searchContent.length });
                lastIndex = idx + searchContent.length;
            }

            for (let i = positions.length - 1; i >= 0; i--) {
                const pos = positions[i];
                const startPos = document.positionAt(pos.start);
                const endPos = document.positionAt(pos.end);
                edit.replace(document.uri, new vscode.Range(startPos, endPos), replaceContent);
                changesCount++;
            }

            await vscode.workspace.applyEdit(edit);
            return {
                success: true,
                editType: 'partial',
                changesCount,
                message: `已替换 ${changesCount} 处匹配`,
                originalContent
            };
        } else {
            const idx = searchText.indexOf(searchPattern);
            const startPos = document.positionAt(idx);
            const endPos = document.positionAt(idx + searchContent.length);
            edit.replace(document.uri, new vscode.Range(startPos, endPos), replaceContent);
            await vscode.workspace.applyEdit(edit);

            return {
                success: true,
                editType: 'range',
                changesCount: 1,
                message: `已替换 1 处匹配`,
                originalContent
            };
        }
    }

    static async applyLineEdit(
        document: vscode.TextDocument,
        lineStart: number,
        lineEnd: number,
        newContent: string
    ): Promise<SmartEditResult> {
        const originalContent = document.getText();
        const actualStartLine = Math.max(0, lineStart - 1);
        const actualEndLine = Math.min(document.lineCount - 1, lineEnd - 1);

        const startPos = new vscode.Position(actualStartLine, 0);
        const endPos = new vscode.Position(actualEndLine, document.lineAt(actualEndLine).text.length);
        const range = new vscode.Range(startPos, endPos);

        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, range, newContent);
        await vscode.workspace.applyEdit(edit);

        return {
            success: true,
            editType: 'range',
            changesCount: 1,
            message: `已编辑行 ${lineStart}-${lineEnd}`,
            originalContent
        };
    }

    static async applyFunctionEdit(
        document: vscode.TextDocument,
        functionName: string,
        newContent: string
    ): Promise<SmartEditResult> {
        const originalContent = document.getText();
        const language = document.languageId;
        const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        let funcRegex: RegExp;
        if (language === 'typescript' || language === 'javascript') {
            funcRegex = new RegExp(
                `((?:export\\s+)?(?:async\\s+)?function\\s+${escapedName}\\s*\\([^)]*\\)\\s*{[\\s\\S]*?})\\s*(?=\\n\\S|$)|` +
                `(const\\s+${escapedName}\\s*=\\s*(?:async\\s+)?\\([^)]*\\)\\s*=>\\s*{[\\s\\S]*?})\\s*(?=\\n\\S|$)|` +
                `(const\\s+${escapedName}\\s*=\\s*function\\s*\\([^)]*\\)\\s*{[\\s\\S]*?})\\s*(?=\\n\\S|$)`,
                'g'
            );
        } else if (language === 'python') {
            funcRegex = new RegExp(`(def\\s+${escapedName}\\s*\\([^)]*\\)\\s*:[\\s\\S]*?)(?=\\n(?:\\s{0,4}\\S|\\s*$)|$)`, 'g');
        } else {
            return {
                success: false,
                editType: 'range',
                changesCount: 0,
                message: `不支持的语言: ${language}`,
                originalContent
            };
        }

        const match = funcRegex.exec(originalContent);
        if (!match) {
            return {
                success: false,
                editType: 'range',
                changesCount: 0,
                message: `未找到函数: ${functionName}`,
                originalContent
            };
        }

        const originalFunc = match[1] || match[2] || match[3];
        const startPos = document.positionAt(match.index);
        const endPos = document.positionAt(match.index + originalFunc.length);

        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(startPos, endPos), newContent);
        await vscode.workspace.applyEdit(edit);

        return {
            success: true,
            editType: 'partial',
            changesCount: 1,
            message: `已编辑函数 ${functionName}`,
            originalContent
        };
    }

    static previewChanges(
        oldContent: string,
        newContent: string,
        format: 'unified' | 'sidebyside' | 'summary' = 'unified'
    ): string {
        const similarity = this.calculateSimilarity(oldContent, newContent);
        const hunks = this.computeDiffHunks(oldContent, newContent);

        if (format === 'summary') {
            const addedLines = newContent.split('\n').length - oldContent.split('\n').length;
            return `相似度: ${(similarity * 100).toFixed(1)}%\n` +
                   `修改块数: ${hunks.length}\n` +
                   `行数变化: ${addedLines >= 0 ? '+' : ''}${addedLines}`;
        }

        if (format === 'unified') {
            return this.generateLineDiff(oldContent, newContent);
        }

        return `--- 原文件\n+++ 新文件\n${this.generateLineDiff(oldContent, newContent)}`;
    }
}

export function resolveFilePath(filepath: string, context?: { activeEditor?: vscode.TextEditor }): vscode.Uri | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return null; }

    if (path.isAbsolute(filepath)) {
        return vscode.Uri.file(filepath);
    }

    if (workspaceFolders.length === 1) {
        return vscode.Uri.joinPath(workspaceFolders[0].uri, filepath);
    }

    const normalizedPath = filepath.replace(/\\/g, '/').toLowerCase();
    const activeDocUri = context?.activeEditor?.document?.uri;
    
    if (activeDocUri) {
        const activeWorkspaceFolder = workspaceFolders.find(
            wf => activeDocUri.fsPath.toLowerCase().startsWith(wf.uri.fsPath.replace(/\\/g, '/').toLowerCase())
        );
        if (activeWorkspaceFolder) {
            const candidateUri = vscode.Uri.joinPath(activeWorkspaceFolder.uri, filepath);
            if (fileExistsInWorkspace(candidateUri, workspaceFolders)) {
                return candidateUri;
            }
        }
    }

    for (const wf of workspaceFolders) {
        const candidateUri = vscode.Uri.joinPath(wf.uri, filepath);
        if (fileExistsInWorkspace(candidateUri, workspaceFolders)) {
            return candidateUri;
        }
    }

    return vscode.Uri.joinPath(workspaceFolders[0].uri, filepath);
}

function fileExistsInWorkspace(uri: vscode.Uri, folders: readonly vscode.WorkspaceFolder[]): boolean {
    for (const folder of folders) {
        const folderPath = folder.uri.fsPath.replace(/\\/g, '/').toLowerCase();
        const uriPath = uri.fsPath.replace(/\\/g, '/').toLowerCase();
        if (uriPath.startsWith(folderPath)) {
            try {
                const fs = require('fs');
                return fs.existsSync(uri.fsPath);
            } catch {
                return false;
            }
        }
    }
    return false;
}
