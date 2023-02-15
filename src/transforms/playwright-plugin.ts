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

import { NodePath, PluginItem, types as t } from '@babel/core';
import { error } from '../helpers';

// Map of Playwright hooks to Synthetics DSL
const TRANSFORM_MAP = {
  test: 'journey',
  expect: 'expect',
  step: 'step',
};

// Hooks that are supported by the Synthetics DSL
const SUPPORTED_HOOKS = ['beforeAll', 'afterAll', 'step', 'describe'];

// Hooks that are not supported by the Synthetics DSL
const UNSUPPORTED_HOOKS = [
  'configure',
  'parallel',
  'beforeEach',
  'afterEach',
  'fixme',
  'skip',
  'fail',
  'use',
  'info',
  'only',
  'setTimeout',
  'extend',
];

// Expect matchers
const EXPECT_MATCHERS: Record<string, string> = {
  toHaveTitle: 'await page.title()',
  toHaveURL: 'await page.url()',
  toBeChecked: 'await locator.isChecked()',
  toBeDisabled: 'await locator.isDisabled()',
  toBeEditable: 'await locator.isEditable()',
  toBeEnabled: 'await locator.isEnabled()',
  toBeFocused: 'await locator.isFocused()',
  toBeVisible: 'await locator.isVisible()',
  toBeHidden: 'await locator.isHidden()',
  toContainText: 'await locator.textContent()',
  toHaveAttribute: 'await locator.getAttribute()',
  toHaveCount: 'await locator.count()',
  toHaveId: 'await locator.getAttribute()',
  toHaveText: 'await locator.textContent()',
  toHaveValue: 'await locator.getAttribute()',
  toHaveValues: 'await locator.getAttribute()',
  toBeOK: 'await response.status()',
};
const UNSUPPORTED_EXPECT_METHODS = Object.keys(EXPECT_MATCHERS);

// Symbol to store the imported hooks across the plugin state
const kHooks = Symbol('hooks');
const kVisited = Symbol('visited');

// Pkgname to use for the imports
const PKG_NAME = '@elastic/synthetics';

export default function (): PluginItem {
  return {
    name: 'babel-plugin-playwright-synthetics',
    visitor: {
      Program: {
        enter(path, state) {
          state[kHooks] = new Set<string>();
          path.traverse({
            CallExpression(path) {
              const callee = path.get('callee');
              if (t.isMemberExpression(callee)) {
                const prop = callee.get('property') as NodePath<t.Identifier>;
                if (
                  t.isIdentifier(prop) &&
                  SUPPORTED_HOOKS.includes(prop.node.name) &&
                  prop.node.name !== 'describe' &&
                  prop.node.name !== 'step'
                ) {
                  state[kHooks].add(prop.node.name);
                }
              }
            },
          });
        },
        exit(path) {
          // Replace all the top level journeys with single step journeys
          // after performing all transformations
          path.traverse({
            CallExpression(path) {
              if (t.isIdentifier(path.node.callee, { name: 'test' })) {
                // early exit if we are in some other test framework
                if (!t.isFunction(path.node.arguments[1])) {
                  return;
                }

                const stepName = t.isStringLiteral(path.node.arguments[0])
                  ? path.node.arguments[0].value
                  : 'step';
                const blockStatement = path.get(
                  'arguments.1.body'
                ) as NodePath<t.BlockStatement>;
                const statements = blockStatement.node.body;

                // if the block statement already contains a step,
                // then we skip that path and return
                if (
                  statements.some(
                    statement =>
                      t.isExpressionStatement(statement) &&
                      t.isCallExpression(statement.expression) &&
                      t.isIdentifier(statement.expression.callee, {
                        name: 'step',
                      })
                  )
                ) {
                  return;
                }

                const stepExp = t.callExpression(t.identifier('step'), [
                  t.stringLiteral(stepName),
                  t.arrowFunctionExpression(
                    [],
                    t.blockStatement(statements),
                    true
                  ),
                ]);

                blockStatement.replaceWith(
                  t.blockStatement([t.expressionStatement(stepExp)])
                );
              }
            },
          });
        },
      },
      ImportDeclaration(path, state) {
        const specifiers = path.node.specifiers;
        const source = path.node.source.value;

        // Only transform imports from @playwright/test
        if (source !== '@playwright/test') {
          return;
        }

        for (const specifier of specifiers) {
          // If we are in named exports from plawyright, we need to transform
          if (
            t.isImportSpecifier(specifier) &&
            t.isIdentifier(specifier.imported)
          ) {
            specifier.imported.name =
              TRANSFORM_MAP[specifier.imported.name] || specifier.imported.name;
          }
        }

        // Add step to the import specifier list
        specifiers.push(
          t.importSpecifier(t.identifier('step'), t.identifier('step'))
        );

        // add all the supported methods for the import paths
        for (const hook of state[kHooks].values()) {
          specifiers.push(
            t.importSpecifier(
              t.identifier(hook),
              t.identifier(TRANSFORM_MAP[hook] || hook)
            )
          );
        }

        path.node.specifiers = specifiers;
        // Change the source value to @elastic/synthetics
        path.node.source.value = PKG_NAME;
      },

      CallExpression(path, state) {
        // Check if we are inside a require statement
        if (t.isIdentifier(path.node.callee, { name: 'require' })) {
          const args = path.node.arguments;
          // Change the require path to @elastic/synthetics
          if (
            t.isStringLiteral(args[0]) &&
            args[0].value === '@playwright/test'
          ) {
            args[0].value = PKG_NAME;
            // Add all the supported methods for the require paths
            if (path.parentPath.isVariableDeclarator()) {
              const id = path.parentPath.get('id');
              if (t.isObjectPattern(id)) {
                const node = id.node as t.ObjectPattern;

                // Change the property names to the supported methods
                for (const prop of node.properties) {
                  if (t.isObjectProperty(prop)) {
                    const key = prop.key as t.Identifier;
                    key.name = TRANSFORM_MAP[key.name] || key.name;
                  }
                }

                // Add step to the object property list
                node.properties.push(
                  t.objectProperty(
                    t.identifier('step'),
                    t.identifier('step'),
                    false,
                    true
                  )
                );

                // add all the supported methods to the object shorthand properties
                for (const hook of state[kHooks].values()) {
                  node.properties.push(
                    t.objectProperty(
                      t.identifier(hook),
                      t.identifier(TRANSFORM_MAP[hook] || hook),
                      false,
                      true
                    )
                  );
                }
              }
            }
          }
          return;
        }

        // Check if we are inside a expect call
        // expect("a").toBe("b")
        if (
          t.isIdentifier(path.node.callee, { name: 'expect' }) &&
          t.isMemberExpression(path.parentPath.node) &&
          t.isIdentifier(path.parentPath.node.property)
        ) {
          if (path[kVisited]) {
            return;
          }
          path[kVisited] = true;
          const prop = path.parentPath.node.property;

          if (!UNSUPPORTED_EXPECT_METHODS.includes(prop.name)) {
            return;
          }

          const parent = path.parentPath.findParent(p =>
            p.isExpressionStatement()
          );
          if (t.isNode(parent)) {
            const value = parent.getSource();
            const prev = parent.getPrevSibling();

            prev.addComment(
              'trailing',
              `Not supported: consider using expect(${
                EXPECT_MATCHERS[prop.name]
              }).toBe(<value>)`
            );
            prev.addComment('trailing', value);
            parent.remove();
          }
        }

        // Check if the callee is one of the supported methods from
        // Playwright test library
        if (t.isMemberExpression(path.node.callee)) {
          const callee = path.get('callee');
          const prop = callee.get('property') as NodePath<t.Identifier>;
          if (t.isIdentifier(prop)) {
            // Remove all the unsupported hooks, as it will throw an error
            // when run via Synthetics runner
            if (UNSUPPORTED_HOOKS.includes(prop.node.name)) {
              error(
                `Removing unsupported method: '${
                  prop.node.name
                }' in ${getLocation(state.file?.opts?.filename, prop.node)}\n`
              );
              path.remove();
              return;
            } else if (SUPPORTED_HOOKS.includes(prop.node.name)) {
              // For all supported methods, we transform to the closest
              // alternative in Synthetics DSL
              const name = prop.node.name;

              // treat step as a special case, as we dont need to await on it
              if (name === 'step' && t.isAwaitExpression(path.parent)) {
                path.parentPath.replaceWith(path);
                return;
              }

              // treat describe as a special case, we need to flattern all the
              // tests inside it as separate journeys
              if (name === 'describe') {
                const args = path.node.arguments;
                const statements = [];
                for (const arg of args) {
                  if (t.isFunction(arg)) {
                    const body = (arg.body as t.BlockStatement).body;
                    for (const statement of body) {
                      if (
                        t.isExpressionStatement(statement) &&
                        t.isCallExpression(statement.expression) &&
                        t.isIdentifier(statement.expression.callee, {
                          name: 'test',
                        })
                      ) {
                        statements.push(statement);
                      }
                    }
                  }
                }
                // if we find any test statements, we treat it as a journey
                // and move it to top level
                if (statements.length > 0) {
                  path.replaceWithMultiple(statements);
                }
                return;
              }

              path.replaceWith(
                t.callExpression(
                  t.identifier(TRANSFORM_MAP[name] || name),
                  path.node.arguments
                )
              );
            }
          }
        }
      },
    },
  };
}

function getLocation(filename: string, node: t.Node) {
  const {
    loc: { start, end },
  } = node;
  return `${filename}:${start.line}:${end.line}`;
}
