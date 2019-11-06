

// Based on https://github.com/GamesDoneQuick/sgdq18-layouts/blob/master/src/extension/oot-bingo.ts
// Packages
import * as RequestPromise from 'request-promise';
import WebSocket from 'ws';

// Ours
import * as nodecgApiContext from './util/nodecg-api-context';
import { BingoboardMeta, Bingoboard, BingosyncSocket } from '../../schemas';

import equal = require('deep-equal');
import { Replicant } from 'nodecg/types/server';

const nodecg = nodecgApiContext.get();
const log = new nodecg.Logger(`${nodecg.bundleName}:bingosync`);
const boardMetaRep = nodecg.Replicant<BingoboardMeta>('bingoboardMeta');

const noop = () => {}; // tslint:disable-line:no-empty
const socketUrl = 'wss://sockets.bingosync.com';
const siteUrl = 'https://bingosync.com';

//recover().catch((error) => {
//  log.error(`Failed to recover connection to room ${socketRep.value.roomCode}:`, error);
//});

class BingosyncManager {
  name: string;
  boardRep: Replicant<Bingoboard>;
  socketRep: Replicant<BingosyncSocket>;
  request = RequestPromise.defaults({ jar: true }); // <= Automatically saves and re-uses cookies.
  // interval for a complete update to not miss stuff
  fullUpdateInterval: NodeJS.Timer | undefined;
  // interval the fullUpdate function uses to make sure there wasn't an event that cancels the interval
  tempFullUpdateInterval: NodeJS.Timer | undefined;
  websocket: WebSocket | null = null;

  constructor(name: string, boardRep: Replicant<Bingoboard>, socketRep: Replicant<BingosyncSocket>) {
    this.name = name;
    this.boardRep = boardRep;
    this.socketRep = socketRep;
    // recovering past connection
    // catch startup errors when this is all empty
    if (!this.socketRep.value || !this.socketRep.value.roomCode || !this.socketRep.value.passphrase) {
      if (!this.socketRep.value) {
        this.socketRep.value = { status: 'disconnected' };
        return;
      }
      this.socketRep.value.status = 'disconnected';
    }
    // Restore previous connection on startup
    const { roomCode, passphrase } = this.socketRep.value;
    if (roomCode && passphrase) {
      log.info(`Recovering connection to room ${this.socketRep.value.roomCode}`);
      this.joinRoom(roomCode, passphrase)
        .then(() => {
          log.info(`Successfully recovered connection to room ${this.socketRep.value.roomCode}`);
        })
        .catch(e => {
          this.socketRep.value.status = 'error';
          log.error(`Couldn't join room ${this.socketRep.value.roomCode}`, e);
        });
    }
  }

  async joinRoom(roomCode: string, passphrase: string) {
    this.socketRep.value.passphrase = passphrase;
    this.socketRep.value.roomCode = roomCode;
    this.socketRep.value.status = 'connecting';
    if (this.fullUpdateInterval) {
      clearInterval(this.fullUpdateInterval);
    }
    this.destroyWebsocket();

    log.info('Fetching bingosync socket key...');
    let data = await this.request.post({
      uri: `${siteUrl}/api/join-room`,
      followAllRedirects: true,
      json: {
        room: roomCode,
        nickname: 'bingothon',
        password: passphrase,
      },
    });

    const socketKey = data['socket_key'];
    log.info('Got bingosync socket key!');

    const thisInterval = setInterval(() => {
      this.fullUpdate(roomCode).catch((error) => {
        log.error('Failed to fullUpdate:', error);
      });
    }, 60 * 1000);
    this.fullUpdateInterval = thisInterval;
    this.tempFullUpdateInterval = thisInterval;

    await this.fullUpdate(roomCode);
    await this.createWebsocket(socketUrl, socketKey);
  }

  async leaveRoom() {
    if (this.fullUpdateInterval) {
      clearInterval(this.fullUpdateInterval);
    }
    this.destroyWebsocket();
    this.socketRep.value.status = 'disconnected';
    this.socketRep.value.passphrase = '';
    this.socketRep.value.roomCode = '';
  }

  async fullUpdate(roomCode: string) {
    const newBoardState = await this.request.get({
      uri: `${siteUrl}/room/${roomCode}/board`,
      json: true,
    });

    // Bail if the room changed while this request was in-flight.
    if (this.fullUpdateInterval !== this.tempFullUpdateInterval) {
      return;
    }

    // Bail if nothing has changed.
    if (equal(this.boardRep.value.cells, newBoardState)) {
      return;
    }
    const goalCounts: {[key: string]: number} = {
      pink: 0, red: 0, orange: 0, brown: 0, yellow: 0, green: 0, teal: 0, blue: 0, navy: 0, purple: 0,
    };

    newBoardState.forEach((cell: {colors: string}) => {
      // remove blank cause thats not a color
      // count all the color occurences
      cell.colors.split(' ').forEach((color) => {
        if (color != 'blank') {
          goalCounts[color]++;
        }
      });
    });

    this.boardRep.value.cells = newBoardState;
    this.boardRep.value.colorCounts = goalCounts;
  }

  async createWebsocket(socketUrl: string, socketKey: string) {
    return new Promise((resolve, reject) => {
      let settled = false;

      log.info('Opening socket...');
      this.socketRep.value.status = 'connecting';
      this.websocket = new WebSocket(`${socketUrl}/broadcast`);

      this.websocket.onopen = () => {
        log.info('Socket opened.');
        if (this.websocket) {
          this.websocket.send(JSON.stringify({ socket_key: socketKey }));
        }
      };

      this.websocket.onmessage = (event: {data: WebSocket.Data; type: string; target: WebSocket}) => {
        let json;
        try {
          json = JSON.parse(event.data as string);
        } catch (error) { // tslint:disable-line:no-unused
          log.error('Failed to parse message:', event.data);
        }

        if (json.type === 'error') {
          if (this.fullUpdateInterval) {
            clearInterval(this.fullUpdateInterval);
          }
          this.destroyWebsocket();
          this.socketRep.value.status = 'error';
          log.error('Socket protocol error:', json.error ? json.error : json);
          if (!settled) {
            reject(new Error(json.error ? json.error : 'unknown error'));
            settled = true;
          }
          return;
        }

        if (!settled) {
          resolve();
          this.socketRep.value.status = 'connected';
          settled = true;
        }

        if (json.type === 'goal') {
          const index = parseInt(json.square.slot.slice(4), 10) - 1;
          this.boardRep.value.cells[index] = json.square;
          const { color } = json;
          this.boardRep.value.cells[index] = json.square;
          // update goal count
          if (json.remove) {
            this.boardRep.value.colorCounts[color]--;
          } else {
            this.boardRep.value.colorCounts[color]++;
          }
        }
      };

      this.websocket.onclose = (event: {wasClean: boolean; code: number; reason: string; target: WebSocket}) => {
        this.socketRep.value.status = 'disconnected';
        log.info(`Socket closed (code: ${event.code}, reason: ${event.reason})`);
        this.destroyWebsocket();
        this.createWebsocket(socketUrl, socketKey).catch(() => {
          // Intentionally discard errors raised here.
          // They will have already been logged in the onmessage handler.
        });
      };
    });
  }

  destroyWebsocket() {
    if (!this.websocket) {
      return;
    }

    try {
      this.websocket.onopen = noop;
      this.websocket.onmessage = noop;
      this.websocket.onclose = noop;
      this.websocket.close();
    } catch (_error) { // tslint:disable-line:no-unused
      // Intentionally discard error.
    }

    this.websocket = null;
  }
}

// create different bingosync instances
const bingosyncInstances: Map<string, BingosyncManager> = new Map();
const mainBoardRep = nodecg.Replicant<Bingoboard>('bingoboard');
const mainSocketRep = nodecg.Replicant<BingosyncSocket>('bingosyncSocket');
const hostingBoardRep = nodecg.Replicant<Bingoboard>('hostingBingoboard');
const hostingSocketRep = nodecg.Replicant<BingosyncSocket>('hostingBingosocket');

bingosyncInstances.set('bingoboard', new BingosyncManager('bingoboard', mainBoardRep, mainSocketRep));
bingosyncInstances.set('hostingBingoboard', new BingosyncManager('hostingBingoboard', hostingBoardRep, hostingSocketRep));

// listeners for messages to interact from the dashboard

nodecg.listenFor('bingosync:joinRoom', async (data, callback) => {
  const manager = bingosyncInstances.get(data.name);
  try {
    if (!manager) {
      if (callback && !callback.handled) {
        callback(new Error(`No Bingosync Manager with name ${data.name} found`));
      }
    } else {
      await manager.joinRoom(
        data.roomCode,
        data.passphrase,
      );
      log.info(`Successfully joined room ${data.roomCode}.`);
      if (callback && !callback.handled) {
        callback(null);
      }
    }
  } catch (error) {
    if (manager) {
      manager.socketRep.value.status = 'error';
    }
    log.error(`Failed to join room ${data.roomCode}:`, error);
    if (callback && !callback.handled) {
      callback(error);
    }
  }
});

nodecg.listenFor('bingosync:leaveRoom', async (data, callback) => {
  const manager = bingosyncInstances.get(data.name);
  try {
    if (!manager) {
      if (callback && !callback.handled) {
        callback(new Error(`No Bingosync Manager with name ${data.name} found`));
      }
    } else {
      await manager.leaveRoom()
      log.info('Left room');
      if (callback && !callback.handled) {
        callback(null);
      }
    }
  } catch (error) {
    log.error('Failed to leave room:', error);
    if (callback && !callback.handled) {
      callback(error);
    }
  }
});

nodecg.listenFor('bingosync:toggleCard', (_data, callback) => {
  try {
    boardMetaRep.value.boardHidden = !boardMetaRep.value.boardHidden;
    if (callback && !callback.handled) {
      callback(null);
    }
  } catch (error) {
    if (callback && !callback.handled) {
      callback(error);
    }
  }
});

nodecg.listenFor('bingosync:toggleColors', (_data, callback) => {
  try {
    boardMetaRep.value.colorShown = !boardMetaRep.value.colorShown;
    if (callback && !callback.handled) {
      callback(null);
    }
  } catch (error) {
    if (callback && !callback.handled) {
      callback(error);
    }
  }
});

nodecg.listenFor('bingosync:setPlayerColor', (data: {idx: number; color: ('pink' | 'red' | 'orange' | 'brown' | 'yellow' | 'green' | 'teal' | 'blue' | 'navy' | 'purple')}, callback) => {
  boardMetaRep.value.playerColors[data.idx] = data.color;
  if (callback && !callback.handled) {
    callback();
  }
});