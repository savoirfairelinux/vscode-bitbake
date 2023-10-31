/* --------------------------------------------------------------------------------------------
 * Copyright (c) 2023 Savoir-faire Linux. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { type HoverParams, type Hover } from 'vscode-languageserver'
import { analyzer } from '../tree-sitter/analyzer'
import { bitBakeDocScanner } from '../BitBakeDocScanner'
import logger from 'winston'

export async function onHoverHandler (params: HoverParams): Promise<Hover | null> {
  const { position, textDocument } = params
  logger.debug(`[onHover] document uri: ${textDocument.uri} position: Line ${position.line} Column ${position.character}`)
  const word = analyzer.wordAtPoint(textDocument.uri, position.line, position.character)
  if (word === null) {
    return null
  }
  // Show documentation of a bitbake variable
  // Triggers only on global declaration expressions like "VAR = 'foo'" but skip the ones like "python VAR(){}"
  const wordIsGlobalDeclarationAndVariableName: boolean = analyzer.getGlobalDeclarationSymbols(textDocument.uri).some((symbol) => symbol.name === word) && analyzer.isIdentifierOfVariableAssignment(params)
  if (wordIsGlobalDeclarationAndVariableName) {
    const found = Object.keys(bitBakeDocScanner.variablesInfos).includes(word)
    if (!found) {
      logger.debug(`[onHover] Not a bitbake variable: ${word}`)
      return null
    }
    logger.debug(`[onHover] Found bitbake variable: ${word}`)
    const range = analyzer.rangeForWordAtPoint(params)
    if (range === undefined) {
      logger.debug(`[onHover] Can't find the range for word: ${word}`)
      return null
    }
    const start = range.start.character
    const end = range.end.character
    if ((start > position.character) || (end <= position.character)) {
      logger.debug(`[onHover] Invalid position: Line: ${position.line} Character: ${position.character}`)
      return null
    }

    const definition = bitBakeDocScanner.variablesInfos[word]?.definition
    const hover: Hover = {
      contents: {
        kind: 'markdown',
        value: `**${word}**\n___\n${definition}`
      }
    }
    logger.debug(`[onHover] Hover item: ${JSON.stringify(hover)}`)
    return hover
  }

  return null
}