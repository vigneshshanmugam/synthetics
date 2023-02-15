/**
 * MIT License
 *
 * Copyright (c) 2020-present, Elastic NV
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */

import { writeFile } from 'fs/promises';
import { transformFileAsync } from '@babel/core';
import PlaywrightToSyntheticsPlugin from './playwright-plugin';
import { isDirectory, totalist } from '../helpers';
import { basename, dirname } from 'path';

export async function loadPWTestFiles(absPath: string, pattern: string) {
  const filePattern = pattern
    ? new RegExp(pattern, 'i')
    : /.+\.(test|spec)\.([mc]js|[jt]s?)$/;
  const ignored = /node_modules/i;

  if (isDirectory(absPath)) {
    await totalist(absPath, async (rel, abs) => {
      if (filePattern.test(rel) && !ignored.test(rel)) {
        await transform(abs);
      }
    });
  } else {
    await transform(absPath);
  }
}

async function transform(filename: string) {
  const { code } = await transformFileAsync(filename, {
    plugins: [PlaywrightToSyntheticsPlugin],
    babelrc: false,
    configFile: false,
  });

  console.log(filename, '\n' + code);
  // convert the test file to a journey file by replacing test|spec with journey
  const outFile =
    dirname(filename) +
    '/' +
    basename(filename).replace(/test|spec/i, 'journey');
  await writeFile(outFile, code, 'utf-8');
}
