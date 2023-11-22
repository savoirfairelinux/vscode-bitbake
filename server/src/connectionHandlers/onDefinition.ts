/* --------------------------------------------------------------------------------------------
 * Copyright (c) 2023 Savoir-faire Linux. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { logger } from '../lib/src/utils/OutputLogger'
import { type TextDocumentPositionParams, type Definition, Location, Range } from 'vscode-languageserver/node'
import { analyzer } from '../tree-sitter/analyzer'
import { type DirectiveStatementKeyword } from '../lib/src/types/directiveKeywords'
import { definitionProvider } from '../DefinitionProvider'
import { bitBakeProjectScanner } from '../BitBakeProjectScanner'
import fs from 'fs'
import path from 'path'

export function onDefinitionHandler (textDocumentPositionParams: TextDocumentPositionParams): Definition | null {
  const { textDocument, position } = textDocumentPositionParams
  logger.debug(`[onDefinition] Position: Line ${position.line} Character ${position.character}`)
  logger.debug(`textdocument uri: ${textDocument.uri}`)
  const documentAsText = analyzer.getDocumentTexts(textDocument.uri)
  if (documentAsText === undefined) {
    logger.debug(`[onDefinition] Document not found for ${textDocument.uri}`)
    return []
  }

  // require, inherit & include directives
  const directiveStatementKeyword = analyzer.getDirectiveStatementKeywordByNodeType(textDocumentPositionParams)
  if (directiveStatementKeyword !== undefined) {
    logger.debug(`[onDefinition] Found directive: ${directiveStatementKeyword}`)
    const definition = getDefinitionForDirectives(directiveStatementKeyword, textDocumentPositionParams, documentAsText)
    logger.debug(`[onDefinition] definition item: ${JSON.stringify(definition)}`)
    return definition
  }

  // SRC_URI & LICFILES_CHECKSUM
  const sourceUri = analyzer.getSourceUriForPosition(textDocument.uri, position.line, position.character)
  if (sourceUri !== undefined) {
    return getDefinitionForSourceUris(sourceUri, textDocument.uri)
  }
  return getDefinition(textDocumentPositionParams, documentAsText)
}

function getDefinitionForSourceUris (sourceUri: string, textDocumentUri: string): Definition {
  const found = bitBakeProjectScanner.recipes.find((recipe) => {
    return textDocumentUri.replace('file://', '').includes(recipe.name)
  })
  logger.debug(`[getDefinitionForSourceUris] foundInProjectScanner: ${JSON.stringify(found)}`)
  let searchFolder = found?.path?.dir
  if (searchFolder !== undefined && found?.layerInfo !== undefined) {
    searchFolder.replace(found.layerInfo.path, '')
  }
  // TODO: Get the layer folder for searching the file
  searchFolder = '/home/zwang/projects/poky'
  logger.debug(`[getDefinitionForSourceUris] searchFolder: ${searchFolder}`)
  logger.debug(`[getDefinitionForSourceUris] sourceUri: ${sourceUri}`)
  const file = findFileInDirectory(searchFolder, sourceUri)
  logger.debug(`[getDefinitionForSourceUris] file: ${file}`)

  const url: string = 'file://' + file
  const location: Location = Location.create(encodeURI(url), Range.create(0, 0, 0, 0))
  // let filePath = findFileInDirectory('/path/to/your/workspace', 'filename.ext');
  return location
}

function findFileInDirectory (dir: string, fileName: string): string | null {
  try {
    const filePaths = fs.readdirSync(dir).map(name => path.join(dir, name))
    for (const filePath of filePaths) {
      if (fs.statSync(filePath).isDirectory()) {
        const result = findFileInDirectory(filePath, fileName)
        if (result !== null) return result
      } else if (path.basename(filePath) === fileName) {
        return filePath
      }
    }
  } catch {
    logger.debug(`[findFileInDirectory] ${dir} not found`)
    return null
  }

  return null
}

function getDefinitionForDirectives (directiveStatementKeyword: DirectiveStatementKeyword, textDocumentPositionParams: TextDocumentPositionParams, documentAsText: string[]): Definition {
  let definition: Definition = []
  const currentLine: string = documentAsText[textDocumentPositionParams.position.line]
  const symbol: string = extractSymbolFromLine(textDocumentPositionParams, currentLine)

  const words: string[] = currentLine.split(' ')

  if (words.length >= 2) {
    if (words[0] === directiveStatementKeyword) {
      logger.debug(`getDefinitionForKeyWord: ${JSON.stringify(words)}`)
      if (words.length === 2) {
        definition = definitionProvider.createDefinitionForKeyword(directiveStatementKeyword, words[1])
      } else {
        definition = definitionProvider.createDefinitionForKeyword(directiveStatementKeyword, words[1], symbol)
      }
    }
  }
  return definition
}

function getDefinition (textDocumentPositionParams: TextDocumentPositionParams, documentAsText: string[]): Definition {
  let definition: Definition = []

  const currentLine = documentAsText[textDocumentPositionParams.position.line]
  const symbol = extractSymbolFromLine(textDocumentPositionParams, currentLine)

  definition = definitionProvider.createDefinitionForSymbol(symbol)
  return definition
}

function extractSymbolFromLine (textDocumentPositionParams: TextDocumentPositionParams, currentLine: string): string {
  logger.debug(`getDefinitionForSymbol ${currentLine}`)
  const linePosition: number = textDocumentPositionParams.position.character
  let symbolEndPosition: number = currentLine.length
  let symbolStartPosition: number = 0
  const rightBorderCharacter: string[] = [' ', '=', '/', '$', '+', '}', '\'', '\'', ']', '[']
  const leftBorderCharacter: string[] = [' ', '=', '/', '+', '{', '\'', '\'', '[', ']']

  for (const character of rightBorderCharacter) {
    let temp: number = currentLine.indexOf(character, linePosition)
    if (temp === -1) {
      temp = currentLine.length
    }
    symbolEndPosition = Math.min(symbolEndPosition, temp)
  }

  const symbolRightTrimed = currentLine.substring(0, symbolEndPosition)
  logger.debug(`symbolRightTrimed ${symbolRightTrimed}`)

  for (const character of leftBorderCharacter) {
    let temp: number = symbolRightTrimed.lastIndexOf(character, linePosition)
    if (temp === -1) {
      temp = 0
    }
    symbolStartPosition = Math.max(symbolStartPosition, temp)
  }

  let symbol: string = symbolRightTrimed.substring(symbolStartPosition)

  for (const character of leftBorderCharacter.concat('-')) {
    if (symbol.startsWith(character)) {
      symbol = symbol.substring(1)
      break
    }
  }

  logger.debug(`symbol ${symbol}`)

  return symbol
}
