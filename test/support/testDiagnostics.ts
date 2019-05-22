// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation.  All rights reserved.
// ----------------------------------------------------------------------------

// Support for testing diagnostics in vscode

// tslint:disable:no-unused-expression no-console no-string-based-set-timeout
// tslint:disable:max-func-body-length radix prefer-template

import * as assert from "assert";
import * as fs from 'fs';
import * as path from 'path';
import { commands, Diagnostic, DiagnosticSeverity, Disposable, languages, TextDocument, window, workspace } from "vscode";
import { diagnosticsCompleteMessage, diagnosticsSource } from "../../extension.bundle";
import { languageServerCompleteMessage } from "../../src/constants";
import { getTempFilePath } from "./getTempFilePath";

export const diagnosticsTimeout = 30000; // CONSIDER: Use this long timeout only for first test, or for suite setup
export const testFolder = path.join(__dirname, '..', '..', '..', 'test');

export const schemaSource = ''; // Built-in schema errors
export const jsonSource = 'json'; // Built-in JSON errors
export const languageServerSource = 'ARM Language Server'; // Language server errors
export const armToolsSource = diagnosticsSource;

interface ITestDiagnosticsOptions {
    ignoreSources?: string[];
    includeRange?: boolean; // defaults to false
}

export function testDiagnosticsDeferred(filePath: string, options?: ITestDiagnosticsOptions, expected?: string[]): void {
    test(filePath);
}

export function testDiagnosticsFromFile(filePath: string | object, options: ITestDiagnosticsOptions, expected: string[]): void {
    test(`File ${filePath}`, async () => {
        let actual: Diagnostic[] = await getDiagnosticsForTemplate(filePath, false);

        let ignoreSources = options.ignoreSources || [];

        // For now, always ignore schema and JSON diagnostics because we don't know when they're fully published
        ignoreSources = ignoreSources.concat([jsonSource, schemaSource]);

        if (options.ignoreSources) {
            actual = actual.filter(d => !options.ignoreSources.includes(d.source));
        }

        compareDiagnostics(actual, expected, options);
    });
}

export function testDiagnostics(testName: string, json: string | object, options: ITestDiagnosticsOptions, expected: string[]): void {
    test(testName, async () => {
        let actual: Diagnostic[] = await getDiagnosticsForTemplate(json);

        let ignoreSources = options.ignoreSources || [];

        // For now, always ignore schema and JSON diagnostics because we don't know when they're fully published
        ignoreSources = ignoreSources.concat([jsonSource, schemaSource]);

        if (options.ignoreSources) {
            actual = actual.filter(d => !options.ignoreSources.includes(d.source));
        }

        compareDiagnostics(actual, expected, options);
    });
}

export async function getDiagnosticsForDocument(document: TextDocument): Promise<Diagnostic[]> {
    let dispose: Disposable;
    let timer: NodeJS.Timer;

    // tslint:disable-next-line:typedef
    let diagnosticsPromise = new Promise<Diagnostic[]>((resolve, reject) => {
        let currentDiagnostics: Diagnostic[] | undefined;
        let complete: boolean;

        function pollDiagnostics(): void {
            currentDiagnostics = languages.getDiagnostics(document.uri);
            if (currentDiagnostics.find(d => d.message === diagnosticsCompleteMessage)
                && currentDiagnostics.find(d => d.message === languageServerCompleteMessage)
            ) {
                complete = true;
                resolve(currentDiagnostics);
            }
        }

        // Poll first in case the diagnostics are already in
        pollDiagnostics();

        // Now only poll on changed events
        if (!complete) {
            timer = setTimeout(
                () => {
                    reject(
                        new Error('Waiting for diagnostics timed out. Last retrieved diagnostics: '
                            + (currentDiagnostics ? currentDiagnostics.map(d => d.message).join('\n') : "None")));
                },
                diagnosticsTimeout);
            dispose = languages.onDidChangeDiagnostics(e => {
                pollDiagnostics();
            });
        }
    });

    let diagnostics = await diagnosticsPromise;
    assert(!!diagnostics);

    if (dispose) {
        dispose.dispose();
    }

    if (timer) {
        clearTimeout(timer);
    }

    return diagnostics.filter(d => d.message !== diagnosticsCompleteMessage && d.message !== languageServerCompleteMessage);
}

export async function getDiagnosticsForTemplate(templateContentsOrFileName: string | { $schema?: string }, addSchema: boolean = true): Promise<Diagnostic[]> {
    let templateContents: string | undefined;
    let filePath: string | undefined;
    let fileToDelete: string | undefined;

    if (typeof templateContentsOrFileName === 'string') {
        if (!!templateContentsOrFileName.match(/\.jsonc?$/)) {
            // It's a filename
            filePath = path.join(testFolder, templateContentsOrFileName);
            assert(!addSchema, "addSchema not supported for filenames");
        } else {
            // It's a string
            templateContents = templateContentsOrFileName;
        }
    } else {
        // It's an object
        let templateObject: { $schema?: string } = templateContentsOrFileName;
        templateContents = JSON.stringify(templateObject, null, 2);
    }

    if (!filePath) {
        if (addSchema) {
            if (!templateContents.includes('$schema')) {
                templateContents = templateContents.replace(/\s*{\s*/, '{\n"$schema": "http://schema.management.azure.com/schemas/2015-01-01/deploymentTemplate.json#",\n');
            }
        }

        filePath = getTempFilePath();
        fs.writeFileSync(filePath, templateContents);
        fileToDelete = filePath;
    }

    let doc = await workspace.openTextDocument(filePath);
    await window.showTextDocument(doc);

    let diagnostics: Diagnostic[] = await getDiagnosticsForDocument(doc);
    assert(!!diagnostics);

    if (fileToDelete) {
        fs.unlinkSync(fileToDelete);
    }

    commands.executeCommand('workbench.action.closeActiveEditor');

    return diagnostics.filter(d => d.message !== diagnosticsCompleteMessage);
}

function diagnosticToString(diagnostic: Diagnostic, options: ITestDiagnosticsOptions): string {
    assert(diagnostic.code === '', `Expecting empty code for all diagnostics, instead found Code="${String(diagnostic.code)}" for "${diagnostic.message}"`);

    let severity: string;
    switch (diagnostic.severity) {
        case DiagnosticSeverity.Error: severity = "Error"; break;
        case DiagnosticSeverity.Warning: severity = "Warning"; break;
        case DiagnosticSeverity.Information: severity = "Information"; break;
        case DiagnosticSeverity.Hint: severity = "Hint"; break;
        default: assert.fail(`Expected severity ${diagnostic.severity}`); break;
    }

    let s = `${severity}: ${diagnostic.message} (${diagnostic.source})`;

    if (options.includeRange === true) {
        if (!diagnostic.range) {
            s += " []";
        } else {
            s += ` [${diagnostic.range.start.line},${diagnostic.range.start.character}`
                + `-${diagnostic.range.end.line},${diagnostic.range.end.character}]`;
        }
    }

    return s;
}

function compareDiagnostics(actual: Diagnostic[], expected: string[], options: ITestDiagnosticsOptions): void {
    let actualAsStrings = actual.map(d => diagnosticToString(d, options));
    assert.deepStrictEqual(actualAsStrings, expected);
}
