#!/usr/bin/env node
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Eugen Wiens. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import path from 'path'
import {
  type Connection,
  type InitializeResult,
  type CompletionItem,
  type Disposable,
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  type InitializeParams,
  SemanticTokensRequest
} from 'vscode-languageserver/node'
import { bitBakeDocScanner } from './BitBakeDocScanner'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { analyzer } from './tree-sitter/analyzer'
import { generateBashParser, generateBitBakeParser } from './tree-sitter/parser'
import { logger } from './lib/src/utils/OutputLogger'
import { onCompletionHandler } from './connectionHandlers/onCompletion'
import { onDefinitionHandler, setDefinitionsConnection } from './connectionHandlers/onDefinition'
import { onHoverHandler } from './connectionHandlers/onHover'
import { generateEmbeddedLanguageDocs, getEmbeddedLanguageTypeOnPosition } from './embedded-languages/general-support'
import { getSemanticTokens, legend } from './semanticTokens'
import { bitBakeProjectScannerClient } from './BitbakeProjectScannerClient'
import { RequestMethod, type RequestParams, type RequestResult } from './lib/src/types/requests'
import { NotificationMethod, type NotificationParams } from './lib/src/types/notifications'
import { expandSettingPath } from './lib/src/BitbakeSettings'
import { onReferenceHandler } from './connectionHandlers/onReference'
import { type BitbakeScanResult } from './lib/src/types/BitbakeScanResult'
import { onPrepareRenameHandler, onRenameRequestHandler } from './connectionHandlers/onRename'
import { loadTextDocument } from './utils/textDocument'

// Create a connection for the server. The connection uses Node's IPC as a transport
export const connection: Connection = createConnection(ProposedFeatures.all)
setDefinitionsConnection(connection)
const documents = new TextDocuments<TextDocument>(TextDocument)
let workspaceFolder: string | undefined
let pokyFolder: string | undefined

const disposables: Disposable[] = []

let currentActiveTextDocument: TextDocument = TextDocument.create(
  'file://dummy_uri',
  'bitbake',
  0,
  ''
)

disposables.push(
  connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
    logger.level = 'none'
    logger.info('[onInitialize] Initializing connection')

    workspaceFolder = params.workspaceFolders?.[0].uri.replace('file://', '')

    pokyFolder = pokyFolder ?? workspaceFolder

    logger.info('[onInitialize] Parsing doc files')
    bitBakeDocScanner.parseDocs()

    const bitBakeParser = await generateBitBakeParser()
    const bashParser = await generateBashParser()
    analyzer.initialize(bitBakeParser, bashParser)

    return {
      capabilities: {
        workspace: {
          fileOperations: {
            didCreate: {
              filters: [
                {
                  pattern: { glob: '**/*' },
                  scheme: 'file'
                }
              ]
            },
            didDelete: {
              filters: [
                {
                  pattern: { glob: '**/*' },
                  scheme: 'file'
                }
              ]
            },
            didRename: {
              filters: [
                {
                  pattern: { glob: '**/*' },
                  scheme: 'file'
                }
              ]
            }
          }
        },
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: {
          resolveProvider: true,
          triggerCharacters: [':', '[']
        },
        definitionProvider: true,
        referencesProvider: true,
        hoverProvider: true,
        semanticTokensProvider: {
          legend,
          full: true
        },
        renameProvider: {
          prepareProvider: true
        }
      }
    }
  }),

  connection.onDidChangeConfiguration((change) => {
    logger.level = change.settings.bitbake?.loggingLevel ?? logger.level
    const bitbakeFolder = expandSettingPath(change.settings.bitbake?.pathToBitbakeFolder, { workspaceFolder })
    if (bitbakeFolder !== undefined) {
      pokyFolder = path.join(bitbakeFolder, '..') // We assume BitBake is into Poky
    }
  }),

  connection.onCompletion(onCompletionHandler),

  connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    logger.debug(`[onCompletionResolve]: ${JSON.stringify(item)}`)
    return item
  }),

  connection.onDefinition(onDefinitionHandler),

  connection.onReferences(onReferenceHandler),

  connection.onHover(onHoverHandler),

  connection.onRenameRequest(onRenameRequestHandler),

  connection.onPrepareRename(onPrepareRenameHandler),

  connection.workspace.onDidCreateFiles((event) => {
    logger.debug(`[onDidCreateFiles] ${JSON.stringify(event)}`)
    analyzer.clearRecipeLocalFiles()
  }),

  connection.workspace.onDidDeleteFiles((event) => {
    logger.debug(`[onDidDeleteFiles] ${JSON.stringify(event)}`)
    analyzer.clearRecipeLocalFiles()
  }),

  connection.workspace.onDidRenameFiles((event) => {
    logger.debug(`[onDidRenameFiles] ${JSON.stringify(event)}`)
    analyzer.clearRecipeLocalFiles()
  }),

  connection.onRequest(
    RequestMethod.EmbeddedLanguageTypeOnPosition,
    async ({ uriString, position }: RequestParams['EmbeddedLanguageTypeOnPosition']): RequestResult['EmbeddedLanguageTypeOnPosition'] => {
      return getEmbeddedLanguageTypeOnPosition(uriString, position)
    }
  ),
  // Reference: https://github.com/microsoft/vscode-languageserver-node/blob/ed3cd0f78c1495913bda7318ace2be7f968008af/protocol/src/common/protocol.semanticTokens.ts#L61
  connection.onRequest(SemanticTokensRequest.method, ({ textDocument }) => {
    logger.debug(`[OnRequest] <${SemanticTokensRequest.method}> Document uri: ${textDocument.uri}`)
    return getSemanticTokens(textDocument.uri)
  }),

  connection.onRequest(RequestMethod.getLinksInDocument, (params: RequestParams['getLinksInDocument']) => {
    return analyzer.getLinksInStringContent(params.documentUri)
  }),

  connection.onRequest(RequestMethod.ProcessRecipeScanResults, async (param: RequestParams['ProcessRecipeScanResults']) => {
    logger.debug(`[onNotification] <ProcessRecipeScanResults> uri:  ${JSON.stringify(param.uri)} recipe: ${param.chosenRecipe}`)
    analyzer.processRecipeScanResults(param.scanResults, param.chosenRecipe)
    await analyzeDocumentWithItsDependencies(currentActiveTextDocument, true)
  }),

  connection.onRequest(RequestMethod.getVar, async (params: RequestParams['getVar']) => {
    const scanResult = analyzer.getLastScanResult(params.recipe)
    return scanResult?.symbols.find(symbolInfo => symbolInfo.name === params.variable)?.finalValue
  }),

  connection.onRequest(RequestMethod.getAllVar, async (params: RequestParams['getAllVar']) => {
    const scanResult = analyzer.getLastScanResult(params.recipe)
    return scanResult?.symbols.map(symbolInfo => ({ name: symbolInfo.name, value: symbolInfo.finalValue }))
  }),

  connection.onNotification(NotificationMethod.RemoveScanResult, (param: NotificationParams['RemoveScanResult']) => {
    logger.debug(`[onNotification] <${NotificationMethod.RemoveScanResult}> recipe: ${param.recipeName}`)
    analyzer.removeLastScanResultForRecipe(param.recipeName)
  }),

  connection.onNotification(NotificationMethod.ScanComplete, (scanResults: BitbakeScanResult) => {
    bitBakeProjectScannerClient.setScanResults(scanResults)

    logger.debug('Analyzing the current document again...')
    void analyzeDocumentWithItsDependencies(currentActiveTextDocument, true)
  }),

  connection.onShutdown(() => {
    disposables.forEach((disposable) => { disposable.dispose() })
  }),

  documents.onDidOpen(async (event) => {
    await analyzeDocumentWithItsDependencies(event.document)
  }),

  documents.onDidChangeContent(async (event) => {
    await analyzeDocumentWithItsDependencies(event.document)

    if (analyzer.getRecipeLocalFiles(event.document.uri) === undefined) {
      try {
        const recipeLocalFiles = await connection.sendRequest<RequestResult['getRecipeLocalFiles']>(RequestMethod.getRecipeLocalFiles, { uri: event.document.uri.replace('file://', '') })
        analyzer.setRecipeLocalFiles(event.document.uri, recipeLocalFiles)
      } catch (error) {
        // When using the language server without the client, custom requests are not supported
        // The CoC.nvim client will disable the server if an exception is thrown
        logger.error(`Error while getting recipe local files: ${error as any}`)
      }
    }
  })
)

connection.listen()

documents.listen(connection)

async function analyzeDocument (textDocument: TextDocument, shouldForce: boolean): Promise<void> {
  const previousVersion = analyzer.getAnalyzedDocument(textDocument.uri)?.version ?? -1
  if (shouldForce || (textDocument.getText().length > 0 && previousVersion < textDocument.version)) {
    const diagnostics = analyzer.analyze({ document: textDocument, uri: textDocument.uri })
    const embeddedLanguageDocs: NotificationParams['EmbeddedLanguageDocs'] | undefined = generateEmbeddedLanguageDocs(textDocument, pokyFolder)
    if (embeddedLanguageDocs !== undefined) {
      void connection.sendNotification(NotificationMethod.EmbeddedLanguageDocs, embeddedLanguageDocs)
    }
    void connection.sendDiagnostics({ uri: textDocument.uri, diagnostics })
  }
}

async function analyzeDocumentWithItsDependencies (textDocument: TextDocument, shouldForce: boolean = false): Promise<void> {
  let uri: string | undefined
  await analyzeDocument(textDocument, shouldForce)
  while ((uri = analyzer.popDocumentToAnalyse()) !== undefined) {
    const includedDocument = await loadTextDocument(uri)
    if (includedDocument !== undefined) {
      // We don't force analyzation on dependencies.
      // If the document has been modified, then it already has been analyzed and it has a non-dummy version number.
      // If a scan occured while it was the active document, then it already has been forced.
      await analyzeDocument(includedDocument, false)
    }
  }

  currentActiveTextDocument = textDocument
}
