import {
  TSESTree,
  AST_NODE_TYPES,
} from '@typescript-eslint/experimental-utils';
import { isTypeReference } from 'tsutils';
import * as ts from 'typescript';
import * as util from '../util';

type Options = [
  {
    allowVariableAnnotationFromAny?: boolean;
  },
];
type MessageIds =
  | 'typeReferenceResolvesToAny'
  | 'variableDeclarationInitialisedToAnyWithoutAnnotation'
  | 'variableDeclarationInitialisedToAnyWithAnnotation'
  | 'patternVariableDeclarationInitialisedToAny'
  | 'letVariableInitialisedToNullishAndNoAnnotation'
  | 'letVariableWithNoInitialAndNoAnnotation'
  | 'loopVariableInitialisedToAny'
  | 'returnAny'
  | 'passedArgumentIsAny'
  | 'assignmentValueIsAny'
  | 'updateExpressionIsAny'
  | 'booleanTestIsAny'
  | 'switchDiscriminantIsAny'
  | 'switchCaseTestIsAny';

export default util.createRule<Options, MessageIds>({
  name: 'no-unsafe-any',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Detects usages of any which can cause type safety holes within your codebase',
      category: 'Possible Errors',
      recommended: false,
    },
    messages: {
      typeReferenceResolvesToAny:
        'Referenced type {{typeName}} resolves to `any`.',
      variableDeclarationInitialisedToAnyWithAnnotation:
        'Variable declaration is initialised to `any` with an explicit type annotation, which is potentially unsafe. Prefer explicit type narrowing via type guards.',
      variableDeclarationInitialisedToAnyWithoutAnnotation:
        'Variable declaration is initialised to `any` without a type annotation.',
      patternVariableDeclarationInitialisedToAny:
        'Variable declaration is initialised to `any`.',
      letVariableInitialisedToNullishAndNoAnnotation:
        'Variable declared with {{kind}} and initialised to `null` or `undefined` is implicitly typed as `any`. Add an explicit type annotation.',
      letVariableWithNoInitialAndNoAnnotation:
        'Variable declared with {{kind}} with no initial value is implicitly typed as `any`.',
      loopVariableInitialisedToAny: 'Loop variable is typed as `any`.',
      returnAny: 'The type of the return is `any`.',
      passedArgumentIsAny: 'The passed argument is `any`.',
      assignmentValueIsAny: 'The value being assigned is `any`.',
      updateExpressionIsAny: 'The update expression variable is `any`.',
      booleanTestIsAny: 'The {{kind}} test is `any`.',
      switchDiscriminantIsAny: 'The switch discriminant is `any`.',
      switchCaseTestIsAny: 'The switch case test is `any`.',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowVariableAnnotationFromAny: {
            type: 'boolean',
          },
        },
      },
    ],
  },
  defaultOptions: [
    {
      allowVariableAnnotationFromAny: false,
    },
  ],
  create(context, [{ allowVariableAnnotationFromAny }]) {
    const { program, esTreeNodeToTSNodeMap } = util.getParserServices(context);
    const checker = program.getTypeChecker();
    const sourceCode = context.getSourceCode();

    /**
     * @returns true if the type is `any`
     */
    function isAnyType(node: ts.Node): boolean {
      const type = checker.getTypeAtLocation(node);
      return util.isTypeFlagSet(type, ts.TypeFlags.Any);
    }
    /**
     * @returns true if the type is `any[]` or `readonly any[]`
     */
    function isAnyArrayType(node: ts.Node): boolean {
      const type = checker.getTypeAtLocation(node);
      return (
        checker.isArrayType(type) &&
        isTypeReference(type) &&
        util.isTypeFlagSet(checker.getTypeArguments(type)[0], ts.TypeFlags.Any)
      );
    }

    function isAnyOrAnyArrayType(node: ts.Node): boolean {
      return isAnyType(node) || isAnyArrayType(node);
    }

    function reportVariableDeclarationInitialisedToAny(
      node: TSESTree.VariableDeclarator,
    ): void {
      if (!node.id.typeAnnotation) {
        return context.report({
          node,
          messageId: 'variableDeclarationInitialisedToAnyWithoutAnnotation',
        });
      }

      // there is a type annotation

      if (allowVariableAnnotationFromAny) {
        // there is an annotation on the type, and the user indicated they are okay with the "unsafe" conversion
        return;
      }
      if (
        node.id.typeAnnotation.typeAnnotation.type ===
        AST_NODE_TYPES.TSUnknownKeyword
      ) {
        // annotation with unknown is as safe as can be
        return;
      }

      return context.report({
        node,
        messageId: 'variableDeclarationInitialisedToAnyWithAnnotation',
      });
    }

    function checkDestructuringPattern(node: TSESTree.Node): void {
      if (node.type === AST_NODE_TYPES.ObjectPattern) {
        node.properties.forEach(prop => {
          checkDestructuringPattern(prop.value ?? prop);
        });
      } else if (node.type === AST_NODE_TYPES.ArrayPattern) {
        node.elements.forEach(el => {
          checkDestructuringPattern(el);
        });
      } else {
        const tsNode = esTreeNodeToTSNodeMap.get(node);
        if (isAnyOrAnyArrayType(tsNode)) {
          context.report({
            node,
            messageId: 'patternVariableDeclarationInitialisedToAny',
          });
        }
      }
    }

    return {
      // Handled by the no-explicit-any rule (with a fixer)
      //TSAnyKeyword(node): void {},

      // #region typeReferenceResolvesToAny

      TSTypeReference(node): void {
        const tsNode = esTreeNodeToTSNodeMap.get(node);
        if (!isAnyType(tsNode)) {
          return;
        }

        const typeName = sourceCode.getText(node);
        context.report({
          node,
          messageId: 'typeReferenceResolvesToAny',
          data: {
            typeName,
          },
        });
      },

      // #endregion typeReferenceResolvesToAny

      // #region letVariableWithNoInitialAndNoAnnotation

      'VariableDeclaration:matches([kind = "let"], [kind = "var"]) > VariableDeclarator:not([init])'(
        node: TSESTree.VariableDeclarator,
      ): void {
        if (node.id.typeAnnotation) {
          return;
        }

        const parent = node.parent as TSESTree.VariableDeclaration;
        context.report({
          node,
          messageId: 'letVariableWithNoInitialAndNoAnnotation',
          data: {
            kind: parent.kind,
          },
        });
      },

      // #endregion letVariableWithNoInitialAndNoAnnotation

      // #region letVariableInitialisedToNullishAndNoAnnotation

      'VariableDeclaration:matches([kind = "let"], [kind = "var"]) > VariableDeclarator[init]'(
        node: TSESTree.VariableDeclarator,
      ): void {
        if (node.id.typeAnnotation) {
          return;
        }

        const parent = node.parent as TSESTree.VariableDeclaration;
        if (
          util.isNullLiteral(node.init) ||
          util.isUndefinedIdentifier(node.init)
        ) {
          context.report({
            node,
            messageId: 'letVariableInitialisedToNullishAndNoAnnotation',
            data: {
              kind: parent.kind,
            },
          });
        }
      },

      // #endregion letVariableInitialisedToNullishAndNoAnnotation

      // #region variableDeclarationInitialisedToAnyWithAnnotation, variableDeclarationInitialisedToAnyWithoutAnnotation, patternVariableDeclarationInitialisedToAny

      // const x = ...;
      'VariableDeclaration > VariableDeclarator[init] > Identifier.id'(
        node: TSESTree.Identifier,
      ): void {
        const parent = node.parent as TSESTree.VariableDeclarator;
        /* istanbul ignore if */ if (!parent.init) {
          return;
        }

        const tsNode = esTreeNodeToTSNodeMap.get(parent.init);
        if (!isAnyType(tsNode) && !isAnyArrayType(tsNode)) {
          return;
        }

        // the variable is initialised to any | any[]...

        reportVariableDeclarationInitialisedToAny(parent);
      },
      // const x = [];
      // this is a special case, because the type of [] is never[], but the variable gets typed as any[].
      // this means it can't be caught by the above selector
      'VariableDeclaration > VariableDeclarator > ArrayExpression[elements.length = 0].init'(
        node: TSESTree.ArrayExpression,
      ): void {
        const parent = node.parent as TSESTree.VariableDeclarator;

        if (parent.id.typeAnnotation) {
          // note that there is no way to fix the type, so you have to use a type annotation
          // so we don't report variableDeclarationInitialisedToAnyWithAnnotation
          return;
        }

        context.report({
          node: parent,
          messageId: 'variableDeclarationInitialisedToAnyWithoutAnnotation',
        });
      },
      // const { x } = ...;
      'VariableDeclaration > VariableDeclarator[init] > ObjectPattern.id'(
        node: TSESTree.ObjectPattern,
      ): void {
        const parent = node.parent as TSESTree.VariableDeclarator;
        /* istanbul ignore if */ if (!parent.init) {
          return;
        }

        const tsNode = esTreeNodeToTSNodeMap.get(parent.init);
        if (isAnyOrAnyArrayType(tsNode)) {
          // the entire init value is any, so report the entire declaration
          return reportVariableDeclarationInitialisedToAny(parent);
        }

        checkDestructuringPattern(node);
      },
      // const [x] = ...;
      'VariableDeclaration > VariableDeclarator[init] > ArrayPattern.id'(
        node: TSESTree.ArrayPattern,
      ): void {
        const parent = node.parent as TSESTree.VariableDeclarator;
        /* istanbul ignore if */ if (!parent.init) {
          return;
        }

        const tsNode = esTreeNodeToTSNodeMap.get(parent.init);
        if (isAnyOrAnyArrayType(tsNode)) {
          // the entire init value is any, so report the entire declaration
          return reportVariableDeclarationInitialisedToAny(parent);
        }

        checkDestructuringPattern(node);
      },

      // #endregion variableDeclarationInitialisedToAnyWithAnnotation, variableDeclarationInitialisedToAnyWithoutAnnotation, patternVariableDeclarationInitialisedToAny

      // #region loopVariableInitialisedToAny

      'ForOfStatement > VariableDeclaration.left > VariableDeclarator'(
        node: TSESTree.VariableDeclarator,
      ): void {
        const tsNode = esTreeNodeToTSNodeMap.get(node);
        if (isAnyOrAnyArrayType(tsNode)) {
          return context.report({
            node,
            messageId: 'loopVariableInitialisedToAny',
          });
        }
      },

      // #endregion loopVariableInitialisedToAny

      // #region returnAny

      'ReturnStatement[argument]'(node: TSESTree.ReturnStatement): void {
        const argument = util.nullThrows(
          node.argument,
          util.NullThrowsReasons.MissingToken('argument', 'ReturnStatement'),
        );
        const tsNode = esTreeNodeToTSNodeMap.get(argument);

        if (isAnyOrAnyArrayType(tsNode)) {
          context.report({
            node,
            messageId: 'returnAny',
          });
        }
      },
      // () => 1
      'ArrowFunctionExpression > :not(TSESTree.BlockStatement).body'(
        node: TSESTree.Expression,
      ): void {
        const tsNode = esTreeNodeToTSNodeMap.get(node);

        if (isAnyOrAnyArrayType(tsNode)) {
          context.report({
            node,
            messageId: 'returnAny',
          });
        }
      },

      // #endregion returnAny

      // #region passedArgumentIsAny

      'CallExpression[arguments.length > 0]'(
        node: TSESTree.CallExpression,
      ): void {
        for (const argument of node.arguments) {
          const tsNode = esTreeNodeToTSNodeMap.get(argument);

          if (isAnyOrAnyArrayType(tsNode)) {
            context.report({
              node: argument,
              messageId: 'passedArgumentIsAny',
            });
          }
        }
      },

      // #endregion passedArgumentIsAny

      // #region assignmentValueIsAny

      AssignmentExpression(node): void {
        const tsNode = esTreeNodeToTSNodeMap.get(node.right);

        if (isAnyOrAnyArrayType(tsNode)) {
          context.report({
            node,
            messageId: 'assignmentValueIsAny',
          });
        }
      },

      // #endregion assignmentValueIsAny

      // #region updateExpressionIsAny

      UpdateExpression(node): void {
        const tsNode = esTreeNodeToTSNodeMap.get(node.argument);

        if (isAnyType(tsNode)) {
          context.report({
            node,
            messageId: 'updateExpressionIsAny',
          });
        }
      },

      // #endregion updateExpressionIsAny

      // #region booleanTestIsAny

      'IfStatement, WhileStatement, DoWhileStatement, ConditionalExpression'(
        node:
          | TSESTree.IfStatement
          | TSESTree.WhileStatement
          | TSESTree.DoWhileStatement
          | TSESTree.ConditionalExpression,
      ): void {
        const tsNode = esTreeNodeToTSNodeMap.get(node.test);
        const typeToText = {
          [AST_NODE_TYPES.IfStatement]: 'if',
          [AST_NODE_TYPES.WhileStatement]: 'while',
          [AST_NODE_TYPES.DoWhileStatement]: 'do while',
          [AST_NODE_TYPES.ConditionalExpression]: 'ternary',
        };

        if (isAnyOrAnyArrayType(tsNode)) {
          context.report({
            node: node.test,
            messageId: 'booleanTestIsAny',
            data: {
              kind: typeToText[node.type],
            },
          });
        }
      },

      // #endregion booleanTestIsAny

      // #region switchDiscriminantIsAny

      SwitchStatement(node): void {
        const tsNode = esTreeNodeToTSNodeMap.get(node.discriminant);

        if (isAnyOrAnyArrayType(tsNode)) {
          context.report({
            node: node.discriminant,
            messageId: 'switchDiscriminantIsAny',
          });
        }
      },

      // #endregion switchDiscriminantIsAny

      // #region switchCaseTestIsAny

      'SwitchCase[test]'(node: TSESTree.SwitchCase): void {
        const tsNode = esTreeNodeToTSNodeMap.get(
          util.nullThrows(
            node.test,
            util.NullThrowsReasons.MissingToken('test', 'SwitchCase'),
          ),
        );

        if (isAnyOrAnyArrayType(tsNode)) {
          context.report({
            node,
            messageId: 'switchCaseTestIsAny',
          });
        }
      },

      // #endregion switchCaseTestIsAny
    };
  },
});
