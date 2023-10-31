/* --------------------------------------------------------------------------------------------
 * Copyright (c) 2023 Savoir-faire Linux. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { type Memento, commands, window } from 'vscode'
import { type LanguageClient, type Disposable } from 'vscode-languageclient/node'

import { NotificationType } from 'bitbake-common'

export class ClientNotificationManager {
  private readonly _client: LanguageClient
  private readonly _memento: Memento

  constructor (client: LanguageClient, memento: Memento) {
    this._client = client
    this._memento = memento
  }

  buildHandlers (): Disposable[] {
    const handlers = [
      this.buildBitBakeNotFoundHandler()
    ]

    return handlers
  }

  private buildBitBakeNotFoundHandler (): Disposable {
    const isNeverShowAgain = this.checkIsNeverShowAgain(NotificationType.BitBakeNotFound)
    if (isNeverShowAgain) {
      return { dispose: () => {} }
    }
    return this._client.onNotification(NotificationType.BitBakeNotFound, () => {
      void window.showErrorMessage(
        'BitBake folder could not be found. Please set its path in the settings. Optionally, also set an environment script.',
        'Open Settings',
        'Close',
        'Never Show Again'
      )
        .then((item) => {
          if (item === 'Open Settings') {
            void commands.executeCommand('workbench.action.openSettings', 'bitbake')
          } else if (item === 'Never Show Again') {
            void this.neverShowAgain(NotificationType.BitBakeNotFound)
          }
        })
    })
  }

  private neverShowAgain (method: NotificationType): Thenable<void> {
    return this._memento.update(`neverShowAgain/${method}`, true)
  }

  private checkIsNeverShowAgain (method: NotificationType): boolean {
    return this._memento.get(`neverShowAgain/${method}`, false)
  }
}
