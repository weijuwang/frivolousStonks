/*
    frivolousStonks: A virtual stock market for Discord servers.
    Copyright (C) 2022 Matthew Epshtein, Weiju Wang.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import * as Discord from 'discord.js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as schedule from 'node-schedule';
import * as crypto from 'crypto';
import { Mutex } from 'async-mutex';
let moment = require('moment');

// Import environment variables
dotenv.config({ path: __dirname + '/.env' });

let plotly = require('plotly')(process.env.PLOTLY_USERNAME, process.env.PLOTLY_APIKEY);

const client: Discord.Client = new Discord.Client({
  intents: [
    Discord.GatewayIntentBits.Guilds,
    Discord.GatewayIntentBits.GuildMessages,
  ]
});

////////////////////////////////////////////////////////////////////////////////

const DATAFOLDER = 'data/';
const ORDERBOOKFOLDER = 'orderBooks/'
const STOCKDATA = 'stockData';
const TICKERS = 'tickers';
const BACKWARDSTICKERS = 'backwardsTickers';
const USERS = 'users';

const SYSTEMID = 'system';

const MAXDATAPOINTS = 24 * 60;
const TRUEPRICEWEIGHT = 0.1; // where 1 = weight equal to the current actual price
const DEFAULTNUMSHARES = 100;
const PUBLICAVAILSHARES = 2/3; // The portion of shares available to the public at any given time
const MAXTICKERLENGTH = 8;
const DEFAULTNUMCOINS = 1000;

const trueStockPrice = (memberCount: number, numMessages: number, numAuthors: number) =>
  10 * Math.log(memberCount) * (numMessages / numAuthors);

////////////////////////////////////////////////////////////////////////////////

interface UserData {
  coins: number
  holdings: {
    [key: string]: number // server ID => number of stocks held
  }
}

type AllUserData = {
  [key: string]: UserData
}

interface GuildStockData {
  truePriceHistory: number[]
  truePrice: number
  actualPrice: number
  actualPriceHistoryTimestamps: string[]
  actualPriceHistory: number[]
  numShares: number
  sharesLeft: number
}

type AllStockData = {
  [key: string]: GuildStockData
}

interface GuildTempData {
  authors: string[]
  numMessages: number
}

interface OrderBookQueueEntry {
  userId: string // user making the order
  volume: number
}

class OrderBookQueue {
  orders: {
    [key: string]: OrderBookQueueEntry
  } = {}
  queue: string[] = []

  enter(entry: OrderBookQueueEntry): string {
    const entryId = crypto.randomBytes(8).toString('hex');
    this.orders[entryId] = entry;
    this.queue.unshift(entryId);
    return entryId;
  }

  peekNext(): OrderBookQueueEntry | null {
    const nextId = this.queue.at(-1);

    if(nextId === undefined){
      return null;
    }

    return this.orders[nextId];
  }

  dequeueNext(): Boolean {
    const nextId = this.queue.at(-1);

    if(nextId === undefined){
      return false;
    }

    delete this.orders[nextId];
    return true;
  }

  cancel(entryId: string): Boolean {
    const index = this.queue
      .findIndex((entry: string) => entry === entryId);

    if(index === -1){
      return false;
    }

    delete this.orders[entryId];
    this.queue.splice(index);
    return true;
  }
}

class OrderBook {

  limitBuy: {
    [key: number]: OrderBookQueue
  } = {}

  limitSell: {
    [key: number]: OrderBookQueue
  } = {}

  market: OrderBookQueue = new OrderBookQueue()

  orderBuyLimit(entry: OrderBookQueueEntry, price: number, guildId: string): string | null {

    checkUserCoins(entry.userId, entry.volume, price);

    // While there are sellers at this price
    while(price in this.limitSell && entry.volume > 0){

      this.limitSell[price] = Object.assign(new OrderBookQueue(), this.limitSell[price]);

      const seller = this.limitSell[price].peekNext();

      if(entry.volume >= seller!.volume){
        /* The buyer can fulfill the next entire order */

        executeOrder(entry, seller!.userId, guildId);

        entry.volume -= seller!.volume;

        // Remove the sell contract
        this.limitSell[price].dequeueNext();

      } else {
        /* The buyer cannot fulfill the entire order */
        seller!.volume -= entry.volume;
        executeOrder(entry, seller!.userId, guildId);
        entry.volume = 0;
      }
    }

    if(entry.volume === 0){
      return null;
    }

    if(!(price in this.limitBuy)){
      this.limitBuy[price] = new OrderBookQueue();
    }

    return Object.assign(new OrderBookQueue(), this.limitBuy[price]).enter(entry);
  }

  orderSellLimit(entry: OrderBookQueueEntry, price: number, guildId: string): string | null {

    checkUserCoins(entry.userId, entry.volume, price);

    // While there are buyers at this price
    while(price in this.limitBuy && entry.volume > 0){

      this.limitBuy[price] = Object.assign(new OrderBookQueue(), this.limitBuy[price]);

      const buyer = this.limitBuy[price].peekNext();

      if(entry.volume >= buyer!.volume){
        /* The seller can fulfill the next entire order */

        executeOrder(entry, entry.userId, guildId);

        entry.volume -= buyer!.volume;

        // Remove the buy contract
        this.limitBuy[price].dequeueNext();

      } else {
        /* The seller cannot fulfill the entire order */
        buyer!.volume -= entry.volume;
        executeOrder(entry, buyer!.userId, guildId);
        entry.volume = 0;
      }
    }

    if(entry.volume === 0){
      return null;
    }

    if(!(price in this.limitSell)){
      this.limitSell[price] = new OrderBookQueue();
    }

    return Object.assign(new OrderBookQueue(), this.limitSell[price]).enter(entry);
  }
}

class NotEnoughCoinsError extends Error {
  constructor(){
    super("You do not have enough coins for this transaction.");
    Object.setPrototypeOf(this, NotEnoughCoinsError.prototype);
  }
}

////////////////////////////////////////////////////////////////////////////////

let tempMsgData: {
  [key: string]: GuildTempData
} = {};

const stockMutex = new Mutex();

////////////////////////////////////////////////////////////////////////////////

function getCurrTimestamp(){
  return moment().format('YYYY-MM-DD HH:mm:ss');
}

function getTicker(guildId: string){
  return readJSONFile(BACKWARDSTICKERS)[guildId.toUpperCase()] ?? guildId;
}

function getIdentifier(guild: Discord.Guild){
  return getTicker(guild.id) + ' ' + Discord.italic(guild.name);
}

function readJSONFile(filename: string){
  return JSON.parse(fs.readFileSync(DATAFOLDER + filename + '.json').toString());
}

function writeJSONFile(filename: string, object: Object){
  fs.writeFileSync(DATAFOLDER + filename + '.json', JSON.stringify(object));
}

function readAllStockData(): AllStockData {
  return readJSONFile(STOCKDATA);
}

function writeAllStockData(data: AllStockData){
  writeJSONFile(STOCKDATA, data);
}

function readAllUsers(): AllUserData {
  return readJSONFile(USERS);
}

function writeAllUsers(data: AllUserData){
  writeJSONFile(USERS, data);
}

function createOrderBook(guildId: string){
  fs.appendFileSync(DATAFOLDER + ORDERBOOKFOLDER + guildId + '.json', '');
}

function readOrderBook(guildId: string): OrderBook {
  try {
    return Object.assign(new OrderBook(), readJSONFile(ORDERBOOKFOLDER + guildId));
  } catch(error){
    return new OrderBook();
  }
}

function writeOrderBook(guildId: string, object: OrderBook){
  writeJSONFile(ORDERBOOKFOLDER + guildId, object);
}

function executeOrder(order: OrderBookQueueEntry, sellerId: string, guildId: string){

  let newUserData = readAllUsers();
  const stockData = readAllStockData();
  const { userId, volume } = order;

  const numTransferredCoins = volume * stockData[guildId].actualPrice;

  newUserData[userId].coins -= numTransferredCoins;
  if(!(guildId in newUserData[userId].holdings)){
    newUserData[userId].holdings[guildId] = 0;
  }
  newUserData[userId].holdings[guildId] += volume;

  newUserData[sellerId].coins += numTransferredCoins;
  newUserData[sellerId].holdings[guildId] -= volume;
  if(newUserData[sellerId].holdings[guildId] === 0){
    delete newUserData[sellerId].holdings[guildId];
  }

  writeAllUsers(newUserData);
}

function checkUserCoins(userId: string, volume: number, price: number){

  if(userId === SYSTEMID){
    return;
  }

  const userData = readAllUsers();

  let numCoins;
  if(userId in userData){
    numCoins = userData[userId].coins;
  } else {
    numCoins = DEFAULTNUMCOINS;
  }

  if(volume * price > numCoins){
    throw new NotEnoughCoinsError();
  }
}

function getGuild(tickerOrId: string | null, interaction: Discord.Interaction): Discord.Guild | undefined | null {

  /*
  If a guild is returned, it means there is a guild with this ID or ticker.
  If `undefined` is returned, it means no guild exists with this ID or ticker.
  If `null` is returned, it means this ticker is on record as having existed but the bot can no longer see it.
  */

  // If no ticker was given
  if(tickerOrId === null){
    tickerOrId = interaction.guildId!;
  }

  // Assume `tickerOrId` is a guild ID. Find the guild, if any, that it represents
  let guild = client.guilds.cache.get(tickerOrId);

  // If no guild with the ID in `tickerOrId` was found
  if(guild === undefined){

    // Get the ID that `tickerOrId` represents
    tickerOrId = readJSONFile(TICKERS)[tickerOrId.toUpperCase()];

    if(tickerOrId === undefined){
      return undefined;
    }

    // Find the guild with that ID
    guild = client.guilds.cache.get(tickerOrId!);

    if(guild === undefined){
      return null;
    }
  }

  return guild;
}

function adjustStockPrice(guild: Discord.Guild){

  // Read data
  let stockData = readAllStockData();

  let numMessages = 0;
  let numAuthors = 1; // this must be 1 to avoid divide by zero

  if(guild.id in tempMsgData){
    numAuthors = tempMsgData[guild.id].authors.length;
    numMessages = tempMsgData[guild.id].numMessages;
  }

  let thisServer = stockData[guild.id];

  if(thisServer != null){

    let newData = thisServer.truePriceHistory;

    // Add data from the last hour
    newData.unshift(trueStockPrice(guild.memberCount, numMessages, numAuthors));

    // Remove the oldest data point (from exactly 24 hours ago)
    if(newData.length > MAXDATAPOINTS){
      newData.pop();
    }

    thisServer.truePriceHistory = newData;

    // Compute the average of all data points
    thisServer.truePrice = newData.reduce((a: number, b: number) => a + b) / newData.length;

    // The true price pulls the actual price towards it with a certain weight
    thisServer.actualPrice =
      (thisServer.actualPrice + thisServer.truePrice * TRUEPRICEWEIGHT)
      / (TRUEPRICEWEIGHT + 1);

    thisServer.actualPriceHistory.push(thisServer.actualPrice);
    thisServer.actualPriceHistoryTimestamps.push(getCurrTimestamp());

    stockData[guild.id] = thisServer;

  } else {
    // This is the first time we've collected data from this server
    const firstDataPoint = trueStockPrice(guild.memberCount, numMessages, numAuthors);

    stockData[guild.id] = {
      truePriceHistory: [firstDataPoint],
      truePrice: firstDataPoint,
      actualPrice: firstDataPoint,
      actualPriceHistoryTimestamps: [getCurrTimestamp()],
      actualPriceHistory: [firstDataPoint],
      numShares: DEFAULTNUMSHARES,
      sharesLeft: DEFAULTNUMSHARES
    };
  }

  // Write data back to the file
  writeAllStockData(stockData);
}

////////////////////////////////////////////////////////////////////////////////

client.on('ready', () => {
  console.log(`Add with https://discord.com/api/oauth2/authorize?client_id=${client!.user!.id}&permissions=2147485697&scope=bot`);

  // For testing: initializes the Northshore Student Den's order book with 100 sell orders at $3.
  let orderBook = new OrderBook();
  orderBook.orderSellLimit({ userId: SYSTEMID, volume: 100 }, 3, "769222562621292585");
  writeOrderBook("769222562621292585", orderBook);
  
});

client.on('interactionCreate', async (interaction: Discord.Interaction) => {

  if(!interaction.isChatInputCommand()){
    return;
  }

  // All commands are put in a queue to avoid any race conditions
  await stockMutex.runExclusive(async () => {

    /* If the user does not exist in the database, add them */

    let newUserData = readAllUsers();

    if(!(interaction.user.id in newUserData)){
      newUserData[interaction.user.id] = { coins: DEFAULTNUMCOINS, holdings: {} } as UserData;
    }

    writeAllUsers(newUserData);

    /* Process the command */

    try {
      switch(interaction.commandName){

        case 'ping': {
          await interaction.reply('pong');
          return;
        }
    
        case 'price': {
    
          if(interaction.guild === null){
            await interaction.reply('This command cannot be used in DMs.');
            return;
          }
    
          let tickerOrId = interaction.options.getString('ticker');
          let guild = getGuild(tickerOrId, interaction);
    
          switch(guild){
            case null:
              await interaction.reply('Server not found (it is likely no longer trading).');
              return;
    
            case undefined:
              await interaction.reply('Stock ticker or server ID not found.');
              return;
          }
    
          const serverStockData = readAllStockData()[guild.id];
    
          if(serverStockData === undefined){
            await interaction.reply('This server does not have a stock price yet (it may take up to a minute before it gets one, if it was just added to the market).');
            return;
          }
    
          await interaction.reply(
            getIdentifier(guild)
            + ': ₦'
            + (serverStockData.actualPrice).toFixed(0)
          );
          return;
        }
    
        case 'graph': {
    
          // TODO /graph
    
          return;
        }
    
        case 'setticker': {
    
          if(interaction.guild === null){
            await interaction.reply('This command cannot be used in DMs.');
            return;
          }
    
          if(!(interaction.member!.permissions as Discord.PermissionsBitField).has('ManageGuild')){
            await interaction.reply('You do not have permission to run this command.');
            return;
          }
    
          const ticker = interaction.options.getString('ticker')?.toUpperCase();
          const tickers = readJSONFile(TICKERS);
          const backwardsTickers = readJSONFile(BACKWARDSTICKERS);
    
          if(ticker === undefined){
            await interaction.reply('No ticker provided.');
            return;
          }
    
          if(tickers[ticker] !== undefined){
            await interaction.reply('That ticker is already being used.');
            return;
          }
    
          if(ticker.length > MAXTICKERLENGTH){
            await interaction.reply('Tickers may not be more than 8 characters long.');
            return;
          }
    
          if(!/^[A-Z0-9]*$/.exec(ticker)){
            await interaction.reply('Tickers may only consist of letters and numbers.');
            return;
          }
    
          delete tickers[backwardsTickers[interaction.guildId!]];
          tickers[ticker] = interaction.guildId!;
          backwardsTickers[interaction.guildId!] = ticker;
          writeJSONFile(TICKERS, tickers);
          writeJSONFile(BACKWARDSTICKERS, backwardsTickers);
    
          await interaction.reply(`This server's ticker is now "${ticker}".`);
          return;
        }
    
        case 'buy': {
    
          let tickerOrId = interaction.options.getString('ticker');
          let guild = getGuild(tickerOrId, interaction);
    
          switch(guild){
            case null:
              await interaction.reply('Server not found (it is likely no longer trading).');
              return;
    
            case undefined:
              await interaction.reply('Stock ticker or server ID not found.');
              return;
          }
    
          const serverStockData = readAllStockData()[guild.id];
          const volumeLimit = Math.floor(PUBLICAVAILSHARES * serverStockData.sharesLeft);
          const volume = interaction.options.getInteger('volume') ?? 1;
    
          if(volume > volumeLimit){
            await interaction.reply(`You requested ${volume} stocks, but the current limit is ${volumeLimit}. Try again with a smaller volume.`);
            return;
          }
    
          if(volume <= 0){
            await interaction.reply(`Cannot buy a negative or zero number of stocks.`);
            return;
          }

          const price = interaction.options.getInteger('price');
    
          if(price === null){
            /* TODO Market order */
            await interaction.reply("Market orders have not been implemented yet.");

          } else {
            let orderBook = readOrderBook(guild.id);
            const orderId = orderBook.orderBuyLimit({ userId: interaction.user.id, volume: volume }, price, guild.id);
            writeOrderBook(guild.id, orderBook);

            if(orderId === null){
              await interaction.reply(`You bought ${volume} shares of ${getIdentifier(guild)} at ₦${price}.`);
            } else {
              await interaction.reply(`You have placed an order to buy ${volume} shares of ${getIdentifier(guild)} at ₦${price}. Depending on market conditions, this order may take an indefinite amount of time to go through. If you wish to buy stock immediately, do not specify a price.`);
              // TODO DM the user when their order goes through
            }
          }

          return;
        }
    
        case 'sell': {

          let tickerOrId = interaction.options.getString('ticker');
          let guild = getGuild(tickerOrId, interaction);
    
          switch(guild){
            case null:
              await interaction.reply('Server not found (it is likely no longer trading).');
              return;
    
            case undefined:
              await interaction.reply('Stock ticker or server ID not found.');
              return;
          }

          const volume = interaction.options.getInteger('volume') ?? 1;
    
          if(volume <= 0){
            await interaction.reply(`Cannot sell a negative or zero number of stocks.`);
            return;
          }
    
          const price = interaction.options.getInteger('price');
    
          if(price === null){
            /* TODO Market order */
            await interaction.reply("Market orders have not been implemented yet.");

          } else {
            let orderBook = readOrderBook(guild.id);
            const orderId = orderBook.orderSellLimit({ userId: interaction.user.id, volume }, price, guild.id);
            writeOrderBook(guild.id, orderBook);

            if(orderId === null){
              await interaction.reply(`You sold ${volume} shares of ${getIdentifier(guild)} at ₦${price}.`);
            } else {
              await interaction.reply(`You have placed an order to sell ${volume} shares of ${getIdentifier(guild)} at ₦${price} (order ${orderId}). This may take an indefinite amount of time to go through depending on market conditions.`);
              // TODO DM the user when their order goes through
            }
          }

          return;
        }

        case 'balance': {
          await interaction.reply(`Your balance: ₦${newUserData[interaction.user.id].coins}.`);
          return;
        }
    
        case 'cancel': {
          // TODO /cancel
          return;
        }
    
        default: {
          await interaction.reply(`Unknown command ${interaction.commandName}`);
          return;
        }
      }
    } catch(error){
      if(error instanceof NotEnoughCoinsError){
        await interaction.reply('You do not have enough coins to make that transaction.');
        return;
      }
      throw error;
    }
  });
});

client.on('messageCreate', async (message: Discord.Message) => {

  // Do not respond to bots
  if(message.author.bot){
    return;
  }

  let thisServerData = tempMsgData[message.guildId!];

  if(thisServerData === undefined){
    thisServerData = {
      authors: [],
      numMessages: 0
    };
  }

  // If this user hasn't talked since the last update, add them as an author
  if(!thisServerData.authors.includes(message.author.id)){
    thisServerData.authors.push(message.author.id);
  }

  ++thisServerData.numMessages;

  tempMsgData[message.guildId!] = thisServerData;
});

client.on('guildCreate', adjustStockPrice);

////////////////////////////////////////////////////////////////////////////////

// Currently, this updates EVERY MINUTE, on the minute. When changing the frequency, remember to also modify MAXDATAPOINTS.
schedule.scheduleJob('0 * * * * *', async () => {
  await stockMutex.runExclusive(async () => {
    client.guilds.cache.forEach(adjustStockPrice);
    tempMsgData = {};
  });
});

////////////////////////////////////////////////////////////////////////////////

client.login(process.env.DISCORD_TOKEN);