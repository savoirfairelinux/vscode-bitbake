/* --------------------------------------------------------------------------------------------
 * Copyright (c) 2023 Savoir-faire Linux. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { analyzer } from '../tree-sitter/analyzer'
import { generateParser } from '../tree-sitter/parser'
import { onDefinitionHandler } from '../connectionHandlers/onDefinition'
import { FIXTURE_DOCUMENT, DUMMY_URI, FIXTURE_URI } from './fixtures/fixtures'
import { type Location } from 'vscode-languageserver'
import { definitionProvider } from '../DefinitionProvider'
import path from 'path'
import { bitBakeProjectScannerClient } from '../BitbakeProjectScannerClient'
// TODO: Current implementation of the definitionProvider needs to be improved, this test suite should be modified accordingly after
const mockDefinition = (path: string | undefined): void => {
  if (path !== undefined) {
    const location: Location = { uri: 'file://' + path, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }

    jest.spyOn(definitionProvider, 'createDefinitionForKeyword').mockReturnValue(location)
  } else {
    jest.spyOn(definitionProvider, 'createDefinitionForKeyword').mockReturnValue([])
  }
}

describe('on definition', () => {
  beforeAll(async () => {
    if (!analyzer.hasParser()) {
      const parser = await generateParser()
      analyzer.initialize(parser)
    }
    analyzer.resetAnalyzedDocuments()
  })

  beforeEach(() => {
    analyzer.resetAnalyzedDocuments()
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  it('provides definition to directive statement', async () => {
    await analyzer.analyze({
      uri: DUMMY_URI,
      document: FIXTURE_DOCUMENT.DEFINITION
    })

    let position = {
      line: 0,
      character: 9
    }

    mockDefinition(analyzer.getDocumentTexts(DUMMY_URI)?.[position.line].split(' ')[1])

    const definition1 = onDefinitionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position
    })

    expect(definition1).toEqual(
      {
        uri: 'file://dummy',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 }
        }
      }
    )

    position = {
      line: 0,
      character: 0
    }

    mockDefinition(analyzer.getDocumentTexts(DUMMY_URI)?.[position.line].split(' ')[1])

    const definition2 = onDefinitionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position
    })

    expect(definition2).toEqual([])
  })

  it('provides go to definition for variables if the included files also contain the variable', async () => {
    const parsedBazPath = path.parse(FIXTURE_DOCUMENT.BAZ_BBCLASS.uri.replace('file://', ''))
    const parsedFooPath = path.parse(FIXTURE_DOCUMENT.FOO_INC.uri.replace('file://', ''))

    bitBakeProjectScannerClient.bitbakeScanResult = {
      _layers: [],
      _overrides: [],
      _classes: [{
        name: parsedBazPath.name,
        path: parsedBazPath,
        extraInfo: 'layer: core'
      }],
      _recipes: [],
      _includes: [
        {
          name: parsedFooPath.name,
          path: parsedFooPath,
          extraInfo: 'layer: core'
        }
      ]
    }

    await analyzer.analyze({
      uri: DUMMY_URI,
      document: FIXTURE_DOCUMENT.DEFINITION
    })

    const result = onDefinitionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position: {
        line: 10,
        character: 1
      }
    })

    expect(result).toEqual(
      expect.arrayContaining([
        {
          uri: FIXTURE_URI.BAZ_BBCLASS,
          range: {
            start: {
              line: 0,
              character: 0
            },
            end: {
              line: 0,
              character: 27
            }
          }
        },
        {
          uri: FIXTURE_URI.FOO_INC,
          range: {
            start: {
              line: 0,
              character: 0
            },
            end: {
              line: 0,
              character: 23
            }
          }
        }
      ])
    )
  })
})
