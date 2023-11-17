/* --------------------------------------------------------------------------------------------
 * Copyright (c) 2023 Savoir-faire Linux. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { onCompletionHandler } from '../connectionHandlers/onCompletion'
import { analyzer } from '../tree-sitter/analyzer'
import { FIXTURE_DOCUMENT } from './fixtures/fixtures'
import { generateParser } from '../tree-sitter/parser'
import { bitBakeDocScanner } from '../BitBakeDocScanner'
import { bitBakeProjectScanner } from '../BitBakeProjectScanner'

const DUMMY_URI = 'dummy_uri'

/**
 * The onCompletion handler doesn't allow other parameters, so we can't pass the analyzer and therefore the same
 * instance used in the handler is used here. Documents are reset before each test for a clean state.
 * A possible alternative is making the entire server a class and the analyzer a member
 */
describe('On Completion', () => {
  beforeAll(async () => {
    if (!analyzer.hasParser()) {
      const parser = await generateParser()
      analyzer.initialize(parser)
    }
    analyzer.resetAnalyzedDocuments()
  })

  beforeEach(() => {
    analyzer.resetAnalyzedDocuments()
    bitBakeDocScanner.clearScannedDocs()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('expects reserved variables, keywords and snippets in completion item lists', async () => {
    // nothing is analyzed yet, and docs are not scanned. Only the static and fallback completion items are provided
    const result = onCompletionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position: {
        line: 0,
        character: 1
      }
    })

    expect('length' in result).toBe(true)

    expect(result).toEqual(
      expect.arrayContaining([
        {
          kind: 14,
          label: 'python'
        }
      ])
    )

    expect(result).toEqual(
      expect.arrayContaining([
        {
          kind: 6,
          label: 'DESCRIPTION'
        }
      ])
    )

    // Scan docs
    bitBakeDocScanner.parseBitbakeVariablesFile()
    bitBakeDocScanner.parseYoctoVariablesFile()
    bitBakeDocScanner.parseYoctoTaskFile()

    const resultAfterDocScan = onCompletionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position: {
        line: 0,
        character: 1
      }
    })
    // Yocto tasks
    expect(resultAfterDocScan).toEqual(
      /* eslint-disable no-template-curly-in-string */
      expect.arrayContaining([
        {
          documentation: {
            value: '```man\ndo_build (bitbake-language-server)\n\n\n```\n```bitbake\ndo_build(){\n\t# Your code here\n}\n```\n---\nThe default task for all recipes. This task depends on all other normal\ntasks required to build a recipe.\n\n[Reference](https://docs.yoctoproject.org/singleindex.html#do-build)',
            kind: 'markdown'
          },
          labelDetails: {
            description: ''
          },
          insertText: 'do_build(){\n\t${1:# Your code here}\n}',
          insertTextFormat: 2,
          label: 'do_build',
          kind: 15
        }
      ])
    )
    // Variables from yocto docs after filtering the duplicates
    expect(resultAfterDocScan).toEqual(
      expect.arrayContaining([
        {
          documentation: {
            value: '```man\nDESCRIPTION (bitbake-language-server)\n\n\n```\n```bitbake\n\n```\n---\n   The package description used by package managers. If not set,\n   `DESCRIPTION` takes the value of the `SUMMARY`\n   variable.\n\n\n[Reference](https://docs.yoctoproject.org/ref-manual/variables.html#term-DESCRIPTION)',
            kind: 'markdown'
          },
          labelDetails: {
            description: 'Source: Yocto'
          },
          insertText: undefined,
          insertTextFormat: 1,
          label: 'DESCRIPTION',
          kind: 6
        }
      ])
    )
    // Variables from bitbake docs after filtering the duplicates
    expect(resultAfterDocScan).toEqual(
      expect.arrayContaining([
        {
          documentation: {
            /* eslint-disable no-useless-escape */
            value: '```man\nBB_HASH_CODEPARSER_VALS (bitbake-language-server)\n\n\n```\n```bitbake\n\n```\n---\n   Specifies values for variables to use when populating the codeparser cache.\n   This can be used selectively to set dummy values for variables to avoid\n   the codeparser cache growing on every parse. Variables that would typically\n   be included are those where the value is not significant for where the\n   codeparser cache is used (i.e. when calculating variable dependencies for\n   code fragments.) The value is space-separated without quoting values, for\n   example:\n BB_HASH_CODEPARSER_VALS = \"T=/ WORKDIR=/ DATE=1234 TIME=1234\"\n\n\n[Reference](https://docs.yoctoproject.org/bitbake/bitbake-user-manual/bitbake-user-manual-ref-variables.html#term-BB_HASH_CODEPARSER_VALS)',
            kind: 'markdown'
          },
          labelDetails: {
            description: 'Source: Bitbake'
          },
          insertText: undefined,
          insertTextFormat: 1,
          label: 'BB_HASH_CODEPARSER_VALS',
          kind: 6
        }
      ])
    )

    // Variables from Yocto docs but not in bitbake docs
    expect(resultAfterDocScan).toEqual(
      /* eslint-disable no-template-curly-in-string */
      expect.arrayContaining([
        {
          documentation: {
            value: '```man\nAPPEND (bitbake-language-server)\n\n\n```\n```bitbake\n\n```\n---\n   An override list of append strings for each target specified with\n   `LABELS`.\n\n   See the `ref-classes-grub-efi` class for more\n   information on how this variable is used.\n\n\n[Reference](https://docs.yoctoproject.org/ref-manual/variables.html#term-APPEND)',
            kind: 'markdown'
          },
          labelDetails: {
            description: 'Source: Yocto'
          },
          insertText: undefined,
          insertTextFormat: 1,
          label: 'APPEND',
          kind: 6
        }
      ])
    )
  })

  it("doesn't provide suggestions when it is pure string content", async () => {
    await analyzer.analyze({
      uri: DUMMY_URI,
      document: FIXTURE_DOCUMENT.COMPLETION
    })

    const result = onCompletionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position: {
        line: 1,
        character: 10
      }
    })

    expect(result).toEqual([])
  })

  it('provides necessary suggestions when it is in variable expansion', async () => {
    await analyzer.analyze({
      uri: DUMMY_URI,
      document: FIXTURE_DOCUMENT.COMPLETION
    })

    const result1 = onCompletionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position: {
        line: 1,
        character: 13
      }
    })
    // Empty ${}
    const result2 = onCompletionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position: {
        line: 8,
        character: 11
      }
    })

    expect(result1).not.toEqual([])
    expect(result1).not.toEqual(
      expect.arrayContaining([
        {
          kind: 14,
          label: 'python'
        }
      ])
    )
    expect(result2).not.toEqual([])
    expect(result2).not.toEqual(
      expect.arrayContaining([
        {
          kind: 14,
          label: 'python'
        }
      ])
    )
  })
  // TODO: Add tests for the second and other overrides that come after. e.g. VAR:override1:override2:over...  And it is better after the tree-sitter library can properly handle it as mentioned in the issue: https://github.com/amaanq/tree-sitter-bitbake/issues/9
  it('provides suggestions for operators when a ":" is typed and it follows an identifier or in the middle of typing such syntax', async () => {
    await analyzer.analyze({
      uri: DUMMY_URI,
      document: FIXTURE_DOCUMENT.COMPLETION
    })

    const result = onCompletionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position: {
        line: 2,
        character: 6
      }
    })

    // In the middle of typing operator/override syntax
    const result2 = onCompletionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position: {
        line: 2,
        character: 7
      }
    })

    expect(result).toEqual(
      expect.arrayContaining([
        {
          label: 'append',
          kind: 24
        }
      ])
    )

    expect(result2).toEqual(
      expect.arrayContaining([
        {
          label: 'append',
          kind: 24
        }
      ])
    )
  })

  it('provides suggestions for overrides when a ":" is typed and it follows an identifier', async () => {
    await analyzer.analyze({
      uri: DUMMY_URI,
      document: FIXTURE_DOCUMENT.COMPLETION
    })

    const spy = jest.spyOn(bitBakeProjectScanner, 'overrides', 'get').mockReturnValue(['class-target'])

    const result = onCompletionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position: {
        line: 2,
        character: 6
      }
    })

    spy.mockRestore()

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining(
          {
            label: 'class-target',
            kind: 10
          }
        )
      ])
    )
  })

  it('provides no suggestions when a ":" is typed but it doesn\'t follow an identifier', async () => {
    await analyzer.analyze({
      uri: DUMMY_URI,
      document: FIXTURE_DOCUMENT.COMPLETION
    })

    const result = onCompletionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position: {
        line: 16,
        character: 1
      }
    })

    expect(result).toEqual([])
  })

  it('provides suggestions for variable flags when a "[" is typed and it follows an identifier (Before and After scanning docs', async () => {
    await analyzer.analyze({
      uri: DUMMY_URI,
      document: FIXTURE_DOCUMENT.COMPLETION
    })

    const result = onCompletionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position: {
        line: 3,
        character: 6
      }
    })

    expect(result).toEqual(
      expect.arrayContaining([
        {
          label: 'cleandirs',
          kind: 14
        }
      ])
    )

    bitBakeDocScanner.parseVariableFlagFile()

    const resultAfterDocScan = onCompletionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position: {
        line: 3,
        character: 6
      }
    })

    expect(resultAfterDocScan).toEqual(
      expect.arrayContaining([
        {
          label: 'cleandirs',
          documentation: {
            value: '```man\ncleandirs (bitbake-language-server)\n\n\n```\n```bitbake\n\n```\n---\n Empty directories that should be created before\n   the task runs. Directories that already exist are removed and\n   recreated to empty them.\n\n[Reference](https://docs.yoctoproject.org/bitbake/bitbake-user-manual/bitbake-user-manual-metadata.html#variable-flags)',
            kind: 'markdown'
          },
          labelDetails: {
            description: ''
          },
          insertText: undefined,
          insertTextFormat: 1,
          kind: 14
        }
      ])
    )
  })

  it('provides no suggestions when a "[" is typed but it doesn\'t follow a bitbake identifier', async () => {
    await analyzer.analyze({
      uri: DUMMY_URI,
      document: FIXTURE_DOCUMENT.COMPLETION
    })

    const result1 = onCompletionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position: {
        line: 15,
        character: 1
      }
    })

    const result2 = onCompletionHandler({
      textDocument: {
        uri: DUMMY_URI
      },
      position: {
        line: 6,
        character: 10
      }
    })

    expect(result1).toEqual([])
    expect(result2).toEqual([])
  })

  it('provides suggestions for direcitive statement after keywords "include", "inherit" and "requrie" are typed', async () => {
    const documentUri = 'file:///home/projects/poky/meta/conf-2/path/to/dummy.bb'
    jest.spyOn(bitBakeProjectScanner, 'includes', 'get').mockReturnValue([
      {
        name: 'init-manager-none',
        path: {
          root: '/',
          dir: '/home/projects/poky/meta/conf/distro/include',
          base: 'init-manager-none.inc',
          ext: '.inc',
          name: 'init-manager-none'
        },
        extraInfo: 'layer: core',
        layerInfo: {
          name: 'core',
          path: '/home/projects/poky/meta',
          priority: 5
        }
      },
      {
        name: 'init-manager-none-2',
        path: {
          root: '/',
          dir: '/home/projects/poky/meta/conf-2/distro/include', // Note that this fake path is under the same "conf-2" folder as the documentUri
          base: 'init-manager-none-2.inc',
          ext: '.inc',
          name: 'init-manager-none-2'
        },
        extraInfo: 'layer: core',
        layerInfo: {
          name: 'core',
          path: '/home/projects/poky/meta',
          priority: 5
        }
      }
    ])

    jest.spyOn(bitBakeProjectScanner, 'classes', 'get').mockReturnValue([{
      name: 'copyleft_filter',
      path: {
        root: '/',
        dir: '/home/projects/poky/meta/classes',
        base: 'copyleft_filter.bbclass',
        ext: '.bbclass',
        name: 'copyleft_filter'
      },
      extraInfo: 'layer: core',
      layerInfo: {
        name: 'core',
        path: '/home/projects/poky/meta',
        priority: 5
      }
    }])

    await analyzer.analyze({
      uri: documentUri,
      document: FIXTURE_DOCUMENT.COMPLETION
    })

    const resultForInclude = onCompletionHandler({
      textDocument: {
        uri: documentUri
      },
      position: {
        line: 10,
        character: 9
      }
    })

    const resultForRequire = onCompletionHandler({
      textDocument: {
        uri: documentUri
      },
      position: {
        line: 11,
        character: 9
      }
    })

    const resultForInherit = onCompletionHandler({
      textDocument: {
        uri: documentUri
      },
      position: {
        line: 12,
        character: 9
      }
    })

    expect(resultForInclude).toEqual(
      expect.arrayContaining([
        expect.objectContaining(
          {
            label: 'init-manager-none.inc',
            kind: 8,
            insertText: 'conf/distro/include/init-manager-none.inc'
          }
        )
      ])
    )

    const index1 = resultForInclude.findIndex((item) => item.label === 'init-manager-none.inc')
    const index2 = resultForInclude.findIndex((item) => item.label === 'init-manager-none-2.inc')
    // Since the path of "init-manager-none-2.inc" is under the same "conf-2" folder as the documentUri, it should be suggested first
    expect(index2).toBeLessThan(index1)

    expect(resultForRequire).toEqual(
      expect.arrayContaining([
        expect.objectContaining(
          {
            label: 'init-manager-none.inc',
            kind: 8,
            insertText: 'conf/distro/include/init-manager-none.inc'
          }
        )
      ])
    )

    expect(resultForInherit).toEqual(
      expect.arrayContaining([
        expect.objectContaining(
          {
            label: 'copyleft_filter',
            kind: 7,
            insertText: 'copyleft_filter'
          }
        )
      ])
    )
  })
})
