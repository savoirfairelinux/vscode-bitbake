/* --------------------------------------------------------------------------------------------
 * Copyright (c) 2023 Savoir-faire Linux. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

/**
 * Inspired by bash-language-server under MIT
 * Reference: https://github.com/bash-lsp/bash-language-server/blob/8c42218c77a9451b308839f9a754abde901323d5/server/src/server.ts#L408
 */

import { logger } from '../lib/src/utils/OutputLogger'
import { type TextDocumentPositionParams, type CompletionItem, type SymbolInformation, CompletionItemKind } from 'vscode-languageserver/node'
import { symbolKindToCompletionKind } from '../utils/lsp'
import { BITBAKE_VARIABLES } from '../completions/bitbake-variables'
import { RESERVED_KEYWORDS } from '../completions/reserved-keywords'
import { analyzer } from '../tree-sitter/analyzer'
import { formatCompletionItems } from '../completions/snippet-utils'
import { bitBakeDocScanner, type DocInfoType } from '../BitBakeDocScanner'
import { BITBAKE_OPERATOR } from '../completions/bitbake-operator'
import { VARIABLE_FLAGS } from '../completions/variable-flags'
import type { ElementInfo } from '../lib/src/types/BitbakeScanResult'
import { bitBakeProjectScannerClient } from '../BitbakeProjectScannerClient'
import path from 'path'

let documentUri = ''

export function onCompletionHandler (textDocumentPositionParams: TextDocumentPositionParams): CompletionItem[] {
  const wordPosition = {
    line: textDocumentPositionParams.position.line,
    // Go one character back to get completion on the current word.
    character: Math.max(textDocumentPositionParams.position.character - 1, 0)
  }

  documentUri = textDocumentPositionParams.textDocument.uri

  const word = analyzer.wordAtPointFromTextPosition({
    ...textDocumentPositionParams,
    position: wordPosition
  })

  logger.debug(`[onCompletion] current word: ${word}`)

  if (analyzer.isStringContent(documentUri, wordPosition.line, wordPosition.character)) {
    return []
  }

  // bitbake operators
  const isOverride = analyzer.isOverride(documentUri, wordPosition.line, wordPosition.character)
  if (word === ':' || isOverride) {
    const wordBeforeIsIdentifier = analyzer.isIdentifier({
      ...textDocumentPositionParams,
      position: {
        line: textDocumentPositionParams.position.line,
        // Go two character back as one character back is ':'
        character: Math.max(textDocumentPositionParams.position.character - 2, 0)
      }
    })
    if (wordBeforeIsIdentifier || isOverride) {
      const bitBakeOperatorCompletionItems: CompletionItem[] = BITBAKE_OPERATOR.map(keyword => {
        return {
          label: keyword,
          kind: CompletionItemKind.Operator
        }
      })

      const bitbakeOverridesCompletionItems: CompletionItem[] = bitBakeProjectScannerClient.bitbakeScanResult._overrides.map((override, index) => {
        let label = override
        if (override === 'pn-defaultpkgname') {
          // eslint-disable-next-line no-template-curly-in-string
          label = '${PN}'
        }
        return {
          label,
          kind: CompletionItemKind.Property,
          // Present overrides after operators, in order of priority
          sortText: '~' + String.fromCharCode(21 + index) + label
        }
      })

      return [...bitBakeOperatorCompletionItems, ...bitbakeOverridesCompletionItems]
    } else {
      return []
    }
  }

  // variable flags
  if (word === '[') {
    const wordBeforeIsIdentifier = analyzer.isIdentifier({
      ...textDocumentPositionParams,
      position: {
        line: textDocumentPositionParams.position.line,
        // Go two character back as one character back is ':'
        character: Math.max(textDocumentPositionParams.position.character - 2, 0)
      }
    })
    if (wordBeforeIsIdentifier) {
      const variableFlagsFromScanner: CompletionItem[] = formatCompletionItems(docInfoToCompletionItems(bitBakeDocScanner.variableFlagInfo), CompletionItemKind.Keyword)

      const variableFlagCompletionItems: CompletionItem[] = VARIABLE_FLAGS.map(keyword => {
        return {
          label: keyword,
          kind: CompletionItemKind.Keyword
        }
      })

      return variableFlagsFromScanner.length > 0 ? variableFlagsFromScanner : variableFlagCompletionItems
    } else {
      return []
    }
  }

  let symbolCompletionItems: CompletionItem[] = []
  if (word !== null) {
    const globalDeclarationSymbols = analyzer.getGlobalDeclarationSymbols(documentUri)
    // Filter out duplicate BITBAKE_VARIABLES as they will be included as global declaration after running analyzer.analyze() in documents.onDidChangeContent() in server.ts
    symbolCompletionItems = [
      ...globalDeclarationSymbols.filter((symbol: SymbolInformation) => !(new Set(BITBAKE_VARIABLES).has(symbol.name))).map((symbol: SymbolInformation) => (
        {
          label: symbol.name,
          kind: symbolKindToCompletionKind(symbol.kind),
          documentation: `${symbol.name}`
        }
      )),
      ...formatCompletionItems(convertExtraSymbolsToCompletionItems(documentUri))
    ]
  }

  // Directive statements completion items. bbclass files, include files, recipe files etc
  const directiveStatementKeyword = analyzer.getDirectiveStatementKeywordByLine(textDocumentPositionParams)
  if (directiveStatementKeyword !== undefined) {
    logger.debug(`[onCompletion] Found directive statement: ${directiveStatementKeyword}`)
    return getCompletionItemForDirectiveStatementKeyword(directiveStatementKeyword)
  }

  let reserverdKeywordCompletionItems: CompletionItem[] = []
  if (!analyzer.isVariableExpansion(documentUri, wordPosition.line, wordPosition.character)) {
    reserverdKeywordCompletionItems = RESERVED_KEYWORDS.map(keyword => {
      return {
        label: keyword,
        kind: CompletionItemKind.Keyword
      }
    })
  }

  const bitBakeVariableCompletionItems: CompletionItem[] = bitBakeDocScanner.bitbakeVariableInfo.length > 0
    ? formatCompletionItems(docInfoToCompletionItems(bitBakeDocScanner.bitbakeVariableInfo), CompletionItemKind.Variable)
    : BITBAKE_VARIABLES.map(keyword => {
      return {
        label: keyword,
        kind: CompletionItemKind.Variable
      }
    })

  const yoctoTaskSnippets: CompletionItem[] = formatCompletionItems(docInfoToCompletionItems(bitBakeDocScanner.yoctoTaskInfo), CompletionItemKind.Snippet)

  const yoctoVariableCompletionItems: CompletionItem[] = formatCompletionItems(docInfoToCompletionItems(bitBakeDocScanner.yoctoVariableInfo), CompletionItemKind.Variable)

  // 1. Remove the duplicate variables by their names. It still keeps the fallback variables from BITBAKE_VARIABLES before scanning the docs since yoctoVariableCompletionItems will be [] in that case
  // 2. Remove the duplicates in variable completion items if they exist in the extra symbols. Keep the ones in the extra symbols as they contain information about the relative path.
  const variableCompletionItems: CompletionItem[] = [...bitBakeVariableCompletionItems.filter((bitbakeVariable) => !yoctoVariableCompletionItems.some(yoctoVariable => yoctoVariable.label === bitbakeVariable.label)),
    ...yoctoVariableCompletionItems
  ].filter((variableCompletionItem) => !symbolCompletionItems.some((symbolCompletionItem) => symbolCompletionItem.label === variableCompletionItem.label))

  const allCompletions = [
    ...reserverdKeywordCompletionItems,
    ...variableCompletionItems,
    ...yoctoTaskSnippets,
    ...symbolCompletionItems
  ]

  return allCompletions
}

/**
 * Convert data in BitBakeDocScanner to completion items
 */
function docInfoToCompletionItems (docInfo: DocInfoType): CompletionItem[] {
  const completionItems: CompletionItem[] = []
  docInfo.forEach((info) => {
    completionItems.push({
      label: info.name,
      labelDetails: {
        description: info.docSource !== undefined ? `Source: ${info.docSource}` : ''
      },
      documentation: info.definition,
      data: {
        referenceUrl: info.referenceUrl
      },
      insertText: info?.insertText
    })
  })

  return completionItems
}

function getCompletionItemForDirectiveStatementKeyword (keyword: string): CompletionItem[] {
  let completionItem: CompletionItem[] = []

  switch (keyword) {
    case 'inherit':
      completionItem = [
        ...convertElementInfoListToCompletionItemList(
          bitBakeProjectScannerClient.bitbakeScanResult._classes,
          CompletionItemKind.Class,
          'bbclass'
        )]
      break
    case 'require':
    case 'include':
      completionItem = [
        ...convertElementInfoListToCompletionItemList(
          bitBakeProjectScannerClient.bitbakeScanResult._includes,
          CompletionItemKind.Interface,
          'inc'
        )
      ]
      break
    default:
      break
  }

  return completionItem
}

function convertElementInfoListToCompletionItemList (elementInfoList: ElementInfo[], completionItemKind: CompletionItemKind, fileType: string): CompletionItem[] {
  const completionItems: CompletionItem[] = []

  for (const element of elementInfoList) {
    const filePath = getFilePath(element, fileType)
    const completionItem: CompletionItem = {
      label: element.name + (element.path?.ext === '.inc' ? '.inc' : ''),
      labelDetails: {
        description: filePath ?? fileType
      },
      insertText: filePath ?? element.name,
      documentation: element.extraInfo,
      data: element,
      kind: completionItemKind
    }
    completionItems.push(completionItem)
  }

  if (completionItems.length > 0) {
    const docUriSplit = documentUri.replace('file://', '').split('/')
    const condition = (item: CompletionItem): boolean => {
      if (item.insertText === undefined || item.insertText.split('.')[0] === item.label.split('.')[0]) {
        return false
      } else {
        return docUriSplit.includes(item.insertText.split('/')[0])
      }
    }

    completionItems.sort((a, b) => Number(condition(b)) - Number(condition(a)))
  }

  return completionItems
}

function getFilePath (elementInfo: ElementInfo, fileType: string): string | undefined {
  if (fileType === 'inc') {
    const path = elementInfo.path
    if (path === undefined) {
      return undefined
    }
    let pathAsString = path.dir.replace(elementInfo.layerInfo?.path ?? '', '')
    if (pathAsString.startsWith('/')) {
      pathAsString = pathAsString.slice(1)
    }

    return pathAsString + '/' + path.base
  }
  return undefined
}

function convertExtraSymbolsToCompletionItems (uri: string): CompletionItem[] {
  logger.debug(`[onCompletion] convertSymbolsToCompletionItems: ${uri}`)
  const completionItems: CompletionItem[] = []
  analyzer.getExtraSymbolsForUri(uri).forEach((extraSymbols) => {
    Object.keys(extraSymbols).forEach((key) => {
      const variableInfo = [
        ...bitBakeDocScanner.bitbakeVariableInfo.filter((bitbakeVariable) => !bitBakeDocScanner.yoctoVariableInfo.some(yoctoVariable => yoctoVariable.name === bitbakeVariable.name)),
        ...bitBakeDocScanner.yoctoVariableInfo
      ]
      const foundInVariableInfo = variableInfo.find((variable) => variable.name === extraSymbols[key].name)
      const completionItem: CompletionItem = {
        label: extraSymbols[key].name,
        labelDetails: {
          description: path.relative(documentUri.replace('file://', ''), extraSymbols[key].location.uri.replace('file://', ''))
        },
        documentation: foundInVariableInfo?.definition ?? '',
        kind: symbolKindToCompletionKind(extraSymbols[key].kind),
        data: {
          referenceUrl: foundInVariableInfo?.referenceUrl
        },
        insertText: foundInVariableInfo?.insertText
      }
      completionItems.push(completionItem)
    })
  })
  return completionItems
}

// TBD: Recipe completion, the code from CompletionProvider.ts
// function createCompletionItemForRecipes (): CompletionItem[] {
//   return [
//     ...convertElementInfoListToCompletionItemList(
//       bitBakeProjectScannerClient.bitbakeScanResult.recipes,
//       CompletionItemKind.Method,
//       'bb'
//     )
//   ]
// }
