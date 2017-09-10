/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as stripJsonComments from 'strip-json-comments';
import { SpectronApplication, VSCODE_BUILD, EXTENSIONS_DIR } from '../../spectron/application';

describe('Debug', () => {
	let app: SpectronApplication = new SpectronApplication();

	if (app.build === VSCODE_BUILD.DEV) {
		const extensionsPath = path.join(os.homedir(), '.vscode-oss-dev', 'extensions');

		const debugPath = path.join(extensionsPath, 'vscode-node-debug');
		const debugExists = fs.existsSync(debugPath);

		const debug2Path = path.join(extensionsPath, 'vscode-node-debug2');
		const debug2Exists = fs.existsSync(debug2Path);

		if (!debugExists) {
			console.warn(`Skipping debug tests because vscode-node-debug extension was not found in ${extensionsPath}`);
			return;
		}

		if (!debug2Exists) {
			console.warn(`Skipping debug tests because vscode-node-debug2 extension was not found in ${extensionsPath}`);
			return;
		}

		fs.symlinkSync(debugPath, path.join(EXTENSIONS_DIR, 'vscode-node-debug'));
		fs.symlinkSync(debug2Path, path.join(EXTENSIONS_DIR, 'vscode-node-debug2'));
	}

	before(() => app.start('Debug'));
	after(() => app.stop());
	beforeEach(function () { app.screenCapturer.testName = this.currentTest.title; });

	it('configure launch json', async function () {
		await app.workbench.debug.openDebugViewlet();
		await app.workbench.openFile('app.js');
		await app.workbench.debug.configure();
		const content = await app.workbench.editor.getEditorVisibleText();

		// TODO@isidor: sometimes on the linux build agent,
		// you get the contents of app.js here, so everything
		// blows up
		const json = JSON.parse(stripJsonComments(content));

		assert.equal(json.configurations[0].request, 'launch');
		assert.equal(json.configurations[0].type, 'node');
		if (process.platform === 'win32') {
			assert.equal(json.configurations[0].program, '${workspaceRoot}\\bin\\www');
		} else {
			assert.equal(json.configurations[0].program, '${workspaceRoot}/bin/www');
		}
	});

	it('breakpoints', async function () {
		await app.workbench.openFile('index.js');
		await app.workbench.debug.setBreakpointOnLine(6);
	});

	it('start debugging', async function () {
		await app.workbench.debug.startDebugging();

		await new Promise(c => {
			setTimeout(() => {
				http.get(`http://localhost:3000`)
					.on('error', e => void 0);
				c();
			}, 400);
		});

		await app.workbench.debug.waitForStackFrame(sf => sf.name === 'index.js' && sf.lineNumber === 6);
	});

	it('focus stack frames and variables', async function () {
		assert.equal(await app.workbench.debug.getLocalVariableCount(), 4);
		await app.workbench.debug.focusStackFrame('layer.js');
		assert.equal(await app.workbench.debug.getLocalVariableCount(), 5);
		await app.workbench.debug.focusStackFrame('route.js');
		assert.equal(await app.workbench.debug.getLocalVariableCount(), 3);
		await app.workbench.debug.focusStackFrame('index.js');
		assert.equal(await app.workbench.debug.getLocalVariableCount(), 4);
	});

	it('stepOver, stepIn, stepOut', async function () {
		await app.workbench.debug.stepIn();
		const first = await app.workbench.debug.waitForStackFrame(sf => sf.name === 'response.js');
		await app.workbench.debug.stepOver();
		await app.workbench.debug.waitForStackFrame(sf => sf.name === 'response.js' && sf.lineNumber === first.lineNumber + 1);
		await app.workbench.debug.stepOut();
		await app.workbench.debug.waitForStackFrame(sf => sf.name === 'index.js' && sf.lineNumber === 7);
	});


	it('continue', async function () {
		await app.workbench.debug.continue();

		await new Promise(c => {
			setTimeout(() => {
				http.get(`http://localhost:3000`)
					.on('error', e => void 0);
				c();
			}, 400);
		});

		await app.workbench.debug.waitForStackFrame(sf => sf.name === 'index.js' && sf.lineNumber === 6);
	});

	it('debug console', async function () {
		const result = await app.workbench.debug.console('2 + 2 \n', 'number');
		assert.equal(result, '4');
	});

	it('stop debugging', async function () {
		await app.workbench.debug.stopDebugging();
	});
});
