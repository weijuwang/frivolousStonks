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

import * as Discord from 'discord.js'
import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as schedule from 'node-schedule'
import * as crypto from 'crypto'
import { Mutex } from 'async-mutex'

dotenv.config({ path: __dirname + '/.env' })
let moment = require('moment')
let plotly = require('plotly')(process.env.PLOTLY_USERNAME, process.env.PLOTLY_APIKEY)

////////////////////////////////////////////////////////////////////////////////
// Types and constructors
////////////////////////////////////////////////////////////////////////////////

type OrderDir   = 'buy' | 'sell'
type OrderType  = 'lim' | 'mkt'
type UserID     = string
type GuildID    = string
type OrderID    = string
type Ticker     = string
type Volume     = number
type Price      = number

interface Order {
    id:         OrderID | null
    dir:        OrderDir
    type:       OrderType
    userId:     UserID
    guildId:    GuildID
    volume:     Volume
    price:      Price
}

interface LimitOrderBook {
    [key: string]: Order[]
}

interface MarketOrderBook {
    buy:    Order[]
    sell:   Order[]
}

function newUser(userId: UserID){
    exchangeData.users[userId] = {
        coins: INIT_COIN_COUNT,
        holdings: {},
        pendingOrders: []
    }
}

function newGuild(guildId: GuildID, ticker: Ticker, ipoPrice: Price){
    exchangeData.guilds[guildId] = {
        ticker: ticker,
        truePriceHist: [ipoPrice],
        truePrice: ipoPrice,
        actualPriceHistTimes: [getCurrTimestamp()],
        actualPriceHist: [ipoPrice],
        lim: {}, // limit orders
        mkt: { // market orders
            buy: [],
            sell: []
        }
    }
}

/**
 * The buyer or seller does not have enough coins for this transaction.
 */
class NotEnoughCoinsError {

    constructor(party: OrderDir){
        this.party = party      
    }

    party: OrderDir
}

/**
 * The order's volume is too large.
 */
class OrderTooLargeError {}

/**
 * No order with that ID exists.
 */
class InvalidOrderIDError {}

////////////////////////////////////////////////////////////////////////////////
// Constants
////////////////////////////////////////////////////////////////////////////////

/**
 * Path to the database.
 */
const DATABASE_PATH = 'data.json'

/**
 * The ID that identifies the stock exchange in cases where the exchange is doing something a user would normally do (e.g. selling newly issued stocks).
 */
const SYSTEM_ID = 'system'
 
/**
 * The number of previous data points that the exchange will use to compute true prices.
 */
const MAX_DATA_POINTS = 24 * 60
 
/**
 * The weight with which the true price will pull the actual price.
 */
const TRUE_PRICE_WEIGHT = 0.1

/**
 * The maximum length of a server's ticker.
 */
const MAX_TICKER_LENGTH = 8
 
/**
 * The number of coins all users are given.
 */
const INIT_COIN_COUNT = 1_000

////////////////////////////////////////////////////////////////////////////////
// Variables
////////////////////////////////////////////////////////////////////////////////

/**
 * This Discord bot.
 */
const client: Discord.Client = new Discord.Client({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMessages,
    ]
})

/**
 * Used whenever reading/writing to the database to prevent race conditions.
 */
const globalMutex = new Mutex()

/**
 * 
 */
let exchangeTempData = {
    authors: [] as UserID[],
    msgCount: 0
}

/**
 * 
 */
let exchangeData = {
    users: {} as {
        [key: UserID]: {
            coins:                  Price
            holdings: {
                [key: GuildID]:     Volume
            }
            pendingOrders:          Order[]
        }
    },
    guilds: {} as {
        [key: GuildID]: {
            ticker:                 Ticker
            truePriceHist:          Price[]
            truePrice:              Price | undefined
            actualPriceHistTimes:   string[]
            actualPriceHist:        Price[]
            lim:                    LimitOrderBook
            mkt:                    MarketOrderBook
        }
    }
}

/**
 * Init the system's user info. This is mostly a formality, but stocks could not be "introduced" into the market without it.
 * The system has an infinite amount of coins and all stocks.
 */
newUser(SYSTEM_ID)
exchangeData.users[SYSTEM_ID].coins = Infinity

////////////////////////////////////////////////////////////////////////////////
// Functions
////////////////////////////////////////////////////////////////////////////////

/**
 * Formula for determining a server's true stock price.
 */
function trueStockPriceFormula(memberCount: number, numMessages: number, numAuthors: number){
    return 10 * Math.log(memberCount) * (numMessages / numAuthors)
}

/**
 * Reads a JSON file.
 */
function readJSONFile(filename: string){
    return JSON.parse(fs.readFileSync(filename).toString())
}

/**
 * Writes a JSON file.
 */
function writeJSONFile(filename: string, object: Object){
    fs.writeFileSync(filename, JSON.stringify(object))
}

/**
 * Get the current timestamp as a string.
 */
function getCurrTimestamp(): string {
    return moment().format('YYYY-MM-DD HH:mm:ss')
}

/**
 * Move a stock's ticker.
 */
function moveTicker(guildId: GuildID, newPrice: Price){
    let guild = exchangeData.guilds[guildId]
    guild.actualPriceHist.push(newPrice)
    guild.actualPriceHistTimes.push(getCurrTimestamp())
}

/**
 * Processes an order.
 * @return The order that was entered into the queue, if any.
 * @note Assumes that the user making the order already has user data initialized in the database.
 * @throw `NotEnoughCoinsError` if the buyer/seller does not have enough coins.
 * 
 * If matching orders exist, they are removed.
 * Any remaining stock unable to be transferred is put in an order in the queue.
 */
function processOrder(order: Order): Order | null {

    let guild = exchangeData.guilds[order.guildId]
    let orderUser = exchangeData.users[order.userId]
    let oppOrder: Order
    let oppDir: OrderDir = 'sell'
    let direction = 1

    // Don't process empty orders
    if(order.volume <= 0)
        return null

    // User has no holdings in this stock
    if(orderUser.holdings[order.guildId] === undefined)
        orderUser.holdings[order.guildId] = 0

    // All of the code below is written and commented like a buy order.
    // However, a sell order just means that stocks and money flow in the opposite direction.
    if(order.dir === 'sell'){
        oppDir = 'buy'
        direction = -1
    }

    /* If all of the user's pending orders were to be fulfilled right now, would they still have enough coins and stock? */

    if(order.userId !== SYSTEM_ID){
        let orderUserTheoreticalCoins = orderUser.coins
        let orderUserTheoreticalHoldings = orderUser.holdings[order.guildId]

        for(const pendingOrder of orderUser.pendingOrders){
            if(pendingOrder.guildId === order.guildId){
                if(pendingOrder.dir === 'sell'){
                    orderUserTheoreticalHoldings -= pendingOrder.volume
                } else if(pendingOrder.dir === 'buy'
                    && pendingOrder.type === 'lim'){
                    orderUserTheoreticalCoins -= pendingOrder.price
                }
            }
        }

        // User doesn't have enough coins to buy
        if(order.type === 'lim'
            && order.dir === 'buy'
            && orderUserTheoreticalCoins < order.price * order.volume
        )
            throw new NotEnoughCoinsError('buy')

        // User won't have enough stocks to sell
        if(order.dir === 'sell'
            && orderUserTheoreticalHoldings < order.volume
        )
            throw new OrderTooLargeError()
    }

    /**
     * @return Whether the entire order was fulfilled.
     */
    function executeOrderPrice(){

        let thisPriceQueue = guild.lim[order.price]

        if(thisPriceQueue !== undefined){

            // While there are market sellers in the queue
            // or there are limit sellers in the queue at this price
            while((guild.mkt[oppDir].length > 0
                    && (oppOrder = guild.mkt[oppDir][0]).dir === oppDir)
                || (thisPriceQueue.length > 0
                    && (oppOrder = thisPriceQueue[0]).dir === oppDir)
            ){
                let oppUser = exchangeData.users[oppOrder.userId]
                const fulfillEntireSellOrder = order.volume >= oppOrder.volume
                const numCoinsTransferred = order.price
                    * (fulfillEntireSellOrder ? oppOrder.volume : order.volume)

                // Take coins from the buyer
                orderUser.coins -= direction * numCoinsTransferred

                // Give those coins to the seller
                oppUser.coins += direction * numCoinsTransferred

                // Take stock from the seller
                oppUser.holdings[order.guildId] -= direction * order.volume

                // Give that stock to the buyer
                orderUser.holdings[order.guildId] += direction * order.volume

                moveTicker(order.guildId, order.price)

                // If the entire sell order can be fulfilled
                if(fulfillEntireSellOrder){

                    // Remove the pending sell order
                    oppUser.pendingOrders.splice(
                        oppUser.pendingOrders.findIndex(order => order.id === oppOrder.id)
                    )

                    // Decrease the number of stocks to buy in the order
                    order.volume -= oppOrder.volume

                    // Remove the sell order
                    thisPriceQueue.shift()

                    // Exit if the buy order has been completely fulfilled
                    if(order.volume === 0)
                        return true

                } else {

                    // Partially fulfill the sell order
                    oppOrder.volume -= direction * order.volume

                    // The buy order has been completely fulfilled, so we're done
                    return true
                }
            }
        } else {
            // Create a queue for this price
            guild.lim[order.price] = []
        }

        return false
    }

    switch(order.type){

        case 'lim':
            if(executeOrderPrice())
                return null
            break

        case 'mkt':
            for(const price of Object.keys(guild.lim)
                .map(p => parseInt(p))
                .sort((a, b) => -1 * direction * (a - b))
            ){
                order.price = price

                if(executeOrderPrice())
                    return null
            }

            guild.lim[order.price] = []
            break
    }

    // If we're here, it means we still want to buy more stock, but no one is selling at that price.
    // Thus, we need to place an order in the queue.
    order.id = crypto.randomBytes(8).toString('hex')
    guild.lim[order.price].push(order)
    orderUser.pendingOrders.push(order)
    return order
}

/**
 * Cancel an order.
 */
function cancelOrder(order: Order){

    /* Remove the order from the user's data */
    let pendingOrders = exchangeData.users[order.userId].pendingOrders

    const orderIndex = pendingOrders.findIndex(thisOrder => thisOrder.id === order.id)

    if(orderIndex === -1)
        throw new InvalidOrderIDError()

    pendingOrders.splice(orderIndex)

    // Remove the order from the queue
    let queueByType = exchangeData.guilds[order.guildId][order.type]
    let queue: Order[]

    if(order.type === 'lim')
        queue = (queueByType as LimitOrderBook)[order.price]
    else
        queue = (queueByType as MarketOrderBook)[order.dir]

    queue.splice(queue.findIndex(thisOrder => thisOrder.id === order.id))
}

// Every minute, on the minute
schedule.scheduleJob('0 * * * * *', async () => {
    await globalMutex.runExclusive(async () => {
        // TODO adjust stock price
    })
})

// When the bot starts
client.on('ready', async () => {
    console.log(`Ready! Add with https://discord.com/api/oauth2/authorize?client_id=${client!.user!.id}&permissions=2147485697&scope=bot`)
})

// When a command is sent
client.on('interactionCreate', async (interaction: Discord.Interaction) => {

})

// When a message is sent
client.on('messageCreate', async (message: Discord.Message) => {

    // Do not respond to bots
    if(message.author.bot)
        return
})

// When the bot joins a server
client.on('guildCreate', async () => {

})

client.login(process.env.DISCORD_TOKEN)