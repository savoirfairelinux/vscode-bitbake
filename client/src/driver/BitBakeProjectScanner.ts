/* --------------------------------------------------------------------------------------------
 * Copyright (c) 2023 Savoir-faire Linux. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import type childProcess from 'child_process'
import find from 'find'
import path from 'path'
import EventEmitter from 'events'
import * as vscode from 'vscode'

import { logger } from '../lib/src/utils/OutputLogger'

import type {
  BitbakeScanResult,
  ElementInfo,
  LayerInfo,
  PathInfo
} from '../lib/src/types/BitbakeScanResult'

import { type BitbakeDriver } from './BitbakeDriver'
import { type LanguageClient } from 'vscode-languageclient/node'

interface ScannStatus {
  scanIsRunning: boolean
  scanIsPending: boolean
}

/**
 * BitBakeProjectScanner
 */
export class BitBakeProjectScanner {
  private readonly _classFileExtension: string = 'bbclass'
  private readonly _includeFileExtension: string = 'inc'
  private readonly _recipesFileExtension: string = 'bb'
  onChange: EventEmitter = new EventEmitter()

  private readonly _bitbakeScanResult: BitbakeScanResult = { _classes: [], _includes: [], _layers: [], _overrides: [], _recipes: [] }
  private _shouldDeepExamine: boolean = false
  private _bitbakeDriver: BitbakeDriver | undefined
  private _languageClient: LanguageClient | undefined

  setDriver (bitbakeDriver: BitbakeDriver): void {
    this._bitbakeDriver = bitbakeDriver
  }

  setClient (languageClient: LanguageClient): void {
    this._languageClient = languageClient
  }

  private readonly _scanStatus: ScannStatus = {
    scanIsRunning: false,
    scanIsPending: false
  }

  get scanResult (): BitbakeScanResult {
    return this._bitbakeScanResult
  }

  get shouldDeepExamine (): boolean {
    return this._shouldDeepExamine
  }

  set shouldDeepExamine (shouldDeepExamine: boolean) {
    this._shouldDeepExamine = shouldDeepExamine
  }

  get bitbakeDriver (): BitbakeDriver | undefined {
    return this._bitbakeDriver
  }

  async rescanProject (): Promise<void> {
    logger.info('request rescanProject')

    if (!this._scanStatus.scanIsRunning) {
      this._scanStatus.scanIsRunning = true
      logger.info('start rescanProject')
      this.onChange.emit('startScan')

      try {
        await this.scanAvailableLayers()
        this.scanForClasses()
        this.scanForIncludeFiles()
        await this.scanForRecipes()
        await this.scanRecipesAppends()
        await this.scanOverrides()
        this.parseAllRecipes()

        logger.info('scan ready')
        this.printScanStatistic()

        void this._languageClient?.sendNotification('bitbake/scanReady', this._bitbakeScanResult)
        this.onChange.emit('scanReady', this._bitbakeScanResult)
      } catch (error) {
        logger.error(`scanning of project is abborted: ${error as any}`)
        this.parseAllRecipes()
        this.onChange.emit('scanReady', { _classes: [], _includes: [], _layers: [], _overrides: [], _recipes: [] })
      }

      this._scanStatus.scanIsRunning = false

      if (this._scanStatus.scanIsPending) {
        this._scanStatus.scanIsPending = false
        await this.rescanProject()
      }
    } else {
      logger.info('scan is already running, set the pending flag')
      this._scanStatus.scanIsPending = true
    }
  }

  private printScanStatistic (): void {
    logger.info('Scan results:')
    logger.info('******************************************************************')
    logger.info(`Layer:     ${this._bitbakeScanResult._layers.length}`)
    logger.info(`Recipes:   ${this._bitbakeScanResult._recipes.length}`)
    logger.info(`Inc-Files: ${this._bitbakeScanResult._includes.length}`)
    logger.info(`bbclass:   ${this._bitbakeScanResult._classes.length}`)
    logger.info(`overrides:   ${this._bitbakeScanResult._overrides.length}`)
  }

  private scanForClasses (): void {
    this._bitbakeScanResult._classes = this.searchFiles(this._classFileExtension)
  }

  private scanForIncludeFiles (): void {
    this._bitbakeScanResult._includes = this.searchFiles(this._includeFileExtension)
  }

  private async scanAvailableLayers (): Promise<void> {
    this._bitbakeScanResult._layers = new Array < LayerInfo >()

    const commandResult = await this.executeBitBakeCommand('bitbake-layers show-layers')

    if (commandResult.status === 0) {
      const output = commandResult.stdout.toString()
      const outputLines = output.split('\n')

      const layersStartRegex = /^layer *path *priority$/
      let layersFirstLine = 0
      for (; layersFirstLine < outputLines.length; layersFirstLine++) {
        if (layersStartRegex.test(outputLines[layersFirstLine])) {
          break
        }
      }

      for (const element of outputLines.slice(layersFirstLine + 2)) {
        const tempElement: string[] = element.split(/\s+/)
        const layerElement = {
          name: tempElement[0],
          path: tempElement[1],
          priority: parseInt(tempElement[2])
        }

        if ((layerElement.name !== undefined) && (layerElement.path !== undefined) && layerElement.priority !== undefined) {
          this._bitbakeScanResult._layers.push(layerElement)
        }
      }
    } else {
      const error = commandResult.stderr.toString()
      logger.error(`can not scan available layers error: ${error}`)
    }
  }

  private searchFiles (pattern: string): ElementInfo[] {
    const elements: ElementInfo[] = new Array < ElementInfo >()

    for (const layer of this._bitbakeScanResult._layers) {
      try {
        const files = find.fileSync(new RegExp(`.${pattern}$`), layer.path)
        for (const file of files) {
          const pathObj: PathInfo = path.parse(file)

          const element: ElementInfo = {
            name: pathObj.name,
            path: pathObj,
            extraInfo: `layer: ${layer.name}`,
            layerInfo: layer
          }

          elements.push(element)
        }
      } catch (error) {
        logger.error(`find error: pattern: ${pattern} layer.path: ${layer.path} error: ${JSON.stringify(error)}`)
        throw error
      }
    }

    return elements
  }

  async scanForRecipes (): Promise<void> {
    this._bitbakeScanResult._recipes = new Array < ElementInfo >()

    const commandResult = await this.executeBitBakeCommand('bitbake-layers show-recipes')
    if (commandResult.status !== 0) {
      logger.error(`Failed to scan recipes: ${commandResult.stderr.toString()}`)
      return
    }

    const output = commandResult.output.toString()

    const outerReg: RegExp = /(.+):\n((?:\s+\S+\s+\S+(?:\s+\(skipped\))?\n)+)/g
    const innerReg: RegExp = /\s+(\S+)\s+(\S+(?:\s+\(skipped\))?)\n/g

    for (const match of output.matchAll(outerReg)) {
      const extraInfoString: string[] = new Array < string >()
      let layerName: string
      let version: string = ''

      for (const matchInner of match[2].matchAll(innerReg)) {
        if (extraInfoString.length === 0) {
          layerName = matchInner[1]
          version = matchInner[2]
        }

        extraInfoString.push(`layer: ${matchInner[1]}`)
        extraInfoString.push(`version: ${matchInner[2]} `)
      }

      const layer = this._bitbakeScanResult._layers.find((obj: LayerInfo): boolean => {
        return obj.name === layerName
      })

      const element: ElementInfo = {
        name: match[1],
        extraInfo: extraInfoString.join('\n'),
        layerInfo: layer,
        version
      }

      this._bitbakeScanResult._recipes.push(element)
    }

    await this.scanForRecipesPath()
  }

  async scanOverrides (): Promise<void> {
    const commandResult = await this.executeBitBakeCommand('bitbake-getvar OVERRIDES')
    if (commandResult.status !== 0) {
      logger.error(`Failed to scan overrides: ${commandResult.stderr.toString()}`)
      return
    }
    const output = commandResult.output.toString()
    const outerReg = /\nOVERRIDES="(.*)"\n/
    this._bitbakeScanResult._overrides = output.match(outerReg)?.[1].split(':') ?? []
  }

  parseAllRecipes (): void {
    void vscode.commands.executeCommand('bitbake.parse-recipes')
  }

  private async scanForRecipesPath (): Promise<void> {
    const tmpFiles = this.searchFiles(this._recipesFileExtension)

    for (const file of tmpFiles) {
      const recipeName: string = file.name.split(/[_]/g)[0]

      const element: ElementInfo | undefined = this._bitbakeScanResult._recipes.find((obj: ElementInfo): boolean => {
        return obj.name === recipeName
      })

      if (element !== undefined) {
        element.path = file.path
      }
    }

    if (this._shouldDeepExamine) {
      const recipesWithOutPath: ElementInfo[] = this._bitbakeScanResult._recipes.filter((obj: ElementInfo): boolean => {
        return obj.path === undefined
      })

      logger.info(`${recipesWithOutPath.length} recipes must be examined more deeply.`)

      for (const recipeWithOutPath of recipesWithOutPath) {
        const commandResult = await this.executeBitBakeCommand(`bitbake-layers show-recipes -f ${recipeWithOutPath.name}`)
        if (commandResult.status !== 0) {
          logger.error(`Failed to scan recipes path: ${commandResult.stderr.toString()}`)
          continue
        }
        const output = commandResult.output.toString()
        const regExp: RegExp = /(\s.*\.bb)/g

        for (const match of output.matchAll(regExp)) {
          recipeWithOutPath.path = path.parse(match[0].trim())
        }
      }
    }
  }

  private async scanRecipesAppends (): Promise<void> {
    const commandResult = await this.executeBitBakeCommand('bitbake-layers show-appends')

    if (commandResult.status !== 0) {
      logger.error(`Failed to scan appends: ${commandResult.stderr.toString()}`)
      return
    }

    const output = commandResult.output.toString()

    // Example:
    // \nbusybox_1.36.1.bb:\n  /home/user/yocto/sources/poky/meta-poky/recipes-core/busybox/busybox_%.bbappend
    const outerReg: RegExp = /\n(.*\.bb):(?:\n\s*\/.*\.bbappend)+/g

    for (const match of output.matchAll(outerReg)) {
      const fullRecipeNameAsArray: string[] = match[1].split('_')

      if (fullRecipeNameAsArray.length > 0) {
        const recipeName: string = fullRecipeNameAsArray[0].split('.')[0]
        const recipeVersion: string | undefined = fullRecipeNameAsArray[1]?.split('.bb')[0]

        const recipe: ElementInfo | undefined = this._bitbakeScanResult._recipes.find((obj: ElementInfo): boolean => {
          return obj.name === recipeName
        })

        if (recipe !== undefined) {
          const innerReg: RegExp = /(\S*\.bbappend)/g

          for (const matchInner of match[0].matchAll(innerReg)) {
            if (recipe.appends === undefined) {
              recipe.appends = new Array < PathInfo >()
            }
            if (bbappendVersionMatches(recipeVersion, recipe.version)) {
              recipe.appends.push(path.parse(matchInner[0]))
            }
          }
        }
      }
    }
  }

  private async executeBitBakeCommand (command: string): Promise<childProcess.SpawnSyncReturns<Buffer>> {
    if (this._bitbakeDriver === undefined) {
      throw new Error('Bitbake driver is not set')
    }
    return await this._bitbakeDriver.spawnBitbakeProcessSync(command)
  }
}

export const bitBakeProjectScanner = new BitBakeProjectScanner()

function bbappendVersionMatches (bbappendVersion: string | undefined, recipeVersion: string | undefined): boolean {
  if (bbappendVersion === undefined) {
    return true
  }
  if (bbappendVersion === '%') {
    return true
  }
  if (recipeVersion === undefined) {
    return bbappendVersion === undefined
  }
  return recipeVersion.startsWith(bbappendVersion)
}
