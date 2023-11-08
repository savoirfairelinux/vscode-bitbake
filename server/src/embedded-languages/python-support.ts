/* --------------------------------------------------------------------------------------------
 * Copyright (c) 2023 Savoir-faire Linux. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { type TextDocument } from 'vscode-languageserver-textdocument'
import { type SyntaxNode } from 'web-tree-sitter'

import { analyzer } from '../tree-sitter/analyzer'
import * as TreeSitterUtils from '../tree-sitter/utils'

import { embeddedLanguageDocsManager } from './documents-manager'
import { logger } from '../lib/src/utils/OutputLogger'
import { type EmbeddedLanguageDoc, insertTextIntoEmbeddedLanguageDoc, initEmbeddedLanguageDoc, isQuotes } from './utils'

export const generatePythonEmbeddedLanguageDoc = async (textDocument: TextDocument): Promise<void> => {
  const analyzedDocument = analyzer.getAnalyzedDocument(textDocument.uri)
  if (analyzedDocument === undefined) {
    return
  }
  const imports: string[] = ['import bb']
  const embeddedLanguageDoc = initEmbeddedLanguageDoc(textDocument, 'python')
  TreeSitterUtils.forEach(analyzedDocument.tree.rootNode, (node) => {
    switch (node.type) {
      case 'recipe':
        return true
      case 'python_function_definition':
        handlePythonFunctionDefinition(node, embeddedLanguageDoc)
        return false
      case 'anonymous_python_function':
        handleAnonymousPythonFunction(node, embeddedLanguageDoc)
        return false
      case 'variable_assignment': // Handle 'inline_python'
        handleVariableAssigmentNode(node, embeddedLanguageDoc)
        return false
      default:
        return false
    }
  })
  insertTextIntoEmbeddedLanguageDoc(embeddedLanguageDoc, 0, 0, imports.join('\n') + '\n')
  await embeddedLanguageDocsManager.saveEmbeddedLanguageDoc(embeddedLanguageDoc)
}

const handlePythonFunctionDefinition = (node: SyntaxNode, embeddedLanguageDoc: EmbeddedLanguageDoc): void => {
  insertTextIntoEmbeddedLanguageDoc(embeddedLanguageDoc, node.startIndex, node.endIndex, node.text)
}

const handleAnonymousPythonFunction = (node: SyntaxNode, embeddedLanguageDoc: EmbeddedLanguageDoc): void => {
  insertTextIntoEmbeddedLanguageDoc(embeddedLanguageDoc, node.startIndex, node.endIndex, node.text)
  node.children.forEach((child) => {
    switch (child.type) {
      case 'python':
        insertTextIntoEmbeddedLanguageDoc(embeddedLanguageDoc, child.startIndex, child.endIndex, 'def')
        break
      case 'identifier':
        break
      case 'override':
        insertTextIntoEmbeddedLanguageDoc(embeddedLanguageDoc, child.startIndex, child.endIndex, ' '.repeat(child.text.length))
        break
      case '{':
        insertTextIntoEmbeddedLanguageDoc(embeddedLanguageDoc, child.startIndex, child.endIndex, ':')
        break
      case '}':
        insertTextIntoEmbeddedLanguageDoc(embeddedLanguageDoc, child.startIndex, child.endIndex, ' ')
        break
      default:
        break
    }
  })
}

const handleVariableAssigmentNode = (node: SyntaxNode, embeddedLanguageDoc: EmbeddedLanguageDoc): void => {
  if (!TreeSitterUtils.containsInlinePython(node)) {
    // We only care about inline python
    return
  }

  // Insert back the whole node, which we'll modify
  insertTextIntoEmbeddedLanguageDoc(embeddedLanguageDoc, node.startIndex, node.endIndex, node.text)

  // Handle operator node such as '=', '??=', '+=', etc.
  const operatorNode = node.child(1)
  if (operatorNode === null) {
    logger.warn('Unexpected variable_assignment node: operator is null')
    return
  }
  // Replace the operator with one that will be valid for sure in Python. It does not matters whih one.
  insertTextIntoEmbeddedLanguageDoc(embeddedLanguageDoc, operatorNode.startIndex, operatorNode.endIndex, '=')

  const literalNode = node.child(2)
  if (literalNode === null) {
    logger.warn('Unexpected variable_assignment node: literal is null')
    return
  }
  const handleLiteralNode = (literalNode: SyntaxNode): void => {
    const stringNode = literalNode.child(0)
    if (stringNode === null) {
      logger.warn('Unexpected variable_assignment node: string is null')
      return
    }
    const handleQuotesNode = (stringNode: SyntaxNode): void => {
      const openingQuoteNode = stringNode.child(0)
      const closingQuoteNode = stringNode.child(stringNode.childCount - 1)
      if (openingQuoteNode === null || !isQuotes(openingQuoteNode?.text)) {
        logger.warn(`Unexpected opening quote node: quote is ${openingQuoteNode?.text}}`)
        return
      }
      if (closingQuoteNode === null || !isQuotes(closingQuoteNode?.text)) {
        logger.warn(`Unexpected closing quote node: quote is ${closingQuoteNode?.text}}`)
        return
      }
      const newQuotes = openingQuoteNode.text.repeat(3)
      // Transform the string into a python f-string
      insertTextIntoEmbeddedLanguageDoc(embeddedLanguageDoc, openingQuoteNode.startIndex, openingQuoteNode.endIndex, `f${newQuotes}`)
      insertTextIntoEmbeddedLanguageDoc(embeddedLanguageDoc, closingQuoteNode.startIndex, closingQuoteNode.endIndex, newQuotes)
    }
    handleQuotesNode(stringNode)

    const handleInlinePythonNode = (inlinePythonNode: SyntaxNode): void => {
      const openingNode = inlinePythonNode.child(0)
      if (openingNode?.type !== '${@') {
        return
      }
      // Replace '${@' for '{', which is the f-string syntax
      insertTextIntoEmbeddedLanguageDoc(embeddedLanguageDoc, openingNode.startIndex, openingNode.endIndex, '{')
    }
    const handleStringContentNode = (stringContentNode: SyntaxNode): void => {
      // Remove all line continuation backslashes ('\')
      for (const match of stringContentNode.text.matchAll(/\\\n/g)) {
        if (match.index === undefined) {
          continue
        }
        const startIndex = stringContentNode.startIndex + match.index
        insertTextIntoEmbeddedLanguageDoc(embeddedLanguageDoc, startIndex, startIndex + 2, '\n')
      }
    }
    TreeSitterUtils.forEach(stringNode, (child) => {
      if (child.type === 'string') {
        return true
      } else if (child.type === 'inline_python') {
        handleInlinePythonNode(child)
      } else if (child.type === 'string_content') {
        handleStringContentNode(child)
      }
      return false
    })
  }
  handleLiteralNode(literalNode)
}
