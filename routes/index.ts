import { JSDOM } from "jsdom";
import * as echarts from "echarts";
import { createCanvas } from "@napi-rs/canvas";

import fetch from "cross-fetch";
import pkg from "@apollo/client";
const { ApolloClient, HttpLink, InMemoryCache, gql } = pkg;
import BigNumber from "bignumber.js";

const twapClient = new ApolloClient({
  link: new HttpLink({
    uri: "https://api.thegraph.com/subgraphs/name/richa-iitr/usdc-eth-pool-tick-data",
    fetch,
  }),
  cache: new InMemoryCache(),
});

//loader

async function fetchData() {
  const tickQuery = `
        query swapDatas($lastID: String) {
            swapDatas(first:1000, where: {id_gt: $lastID}, orderBy: timestamp){
                id
                tick
                timestamp
                blockNumber
                logIndex
                transactionLogIndex
                initialTick
            }
        }
    `;

  try {
    let skip = 0;
    let results = [];
    let found = false;
    let lastId = "";

    while (!found) {
      let result = await twapClient.query({
        query: gql(tickQuery),
        variables: {
          lastID: lastId,
        },
        fetchPolicy: "cache-first",
      });
      let swaps = result.data.swapDatas;
      results = results.concat(swaps);

      if (swaps.length < 1000) {
        found = true;
      } else {
        lastId = swaps[swaps.length - 1].id;
      }
    }

    return results;
  } catch (e) {
    console.error(e);
  }
}

async function processTwap() {
  let map = new Map();
  let blockMap = new Map();
  let tickData = await fetchData();
  let prevTick = new BigNumber(Math.pow(-2, 23));
  let initialTick = new BigNumber(tickData[0].initialTick);
  let initialTime = new BigNumber(tickData[0].timeStamp);

  // map store: timestamp => sum of ticks at that timestamp
  for (let obj of tickData) {
    let timeStamp = new BigNumber(obj.timestamp);
    let tick = new BigNumber(obj.tick);
    let block = new BigNumber(obj.blockNumber);

    let logIndex = new BigNumber(obj.logIndex);
    let transactionLogIndex = new BigNumber(obj.transactionLogIndex);

    if (tick.toFixed() !== prevTick.toFixed()) {
      if (!map.get(timeStamp)) {
        map.set(timeStamp, { tick: tick, logIndex: logIndex });
        prevTick = tick;
        blockMap.set(timeStamp, block);
      } else {
        let prevLog = map.get(timeStamp).logIndex;
        if (logIndex.isGreaterThan(prevLog)) {
          map.set(timeStamp, { tick: tick, logIndex: logIndex });
          prevTick = tick;
        }
      }
    }
  }

  let tickArr = [];

  map.forEach((_data, _time) => {
    tickArr.push({
      timeStamp: new BigNumber(_time).toFixed(),
      tick: new BigNumber(_data.tick).toFixed(),
      block: new BigNumber(blockMap.get(_time)).toFixed(),
    });
  });
  // console.log(tickArr);
  tickArr = tickArr.sort((a, b) => (a.timeStamp > b.timeStamp ? 1 : -1));
  return {
    tickArr: tickArr,
    initialTime: initialTime,
    initialTick: initialTick,
  };
}

//TODO: modify to binary search
function getBounds(timestamp, timeArr) {
  let lowerBound = timeArr[0];
  let upperBound = timeArr[timeArr.length - 1];
  // let upperTick =

  for (let i = 0; i < timeArr.length; i++) {
    let time = timeArr[i];
    if (new BigNumber(time).isGreaterThan(timestamp)) {
      upperBound = BigNumber.minimum(upperBound, new BigNumber(time));
    } else if (new BigNumber(time).isLessThan(timestamp)) {
      lowerBound = BigNumber.maximum(lowerBound, new BigNumber(time));
    }
  }

  return { lowerBound: lowerBound, upperBound: upperBound };
}
async function cumulativeTickToTwap(
  cumulativeTickArr,
  cumulativeTickMap,
  duration,
  timeArr
) {
  let twapArr = [];
  let priceArr = [];
  let blocks = [];
  let lastStoreTime = cumulativeTickArr[cumulativeTickArr.length - 1].timeStamp;

  for (let obj of cumulativeTickArr) {
    let endTime = new BigNumber(obj.timeStamp).plus(duration);
    if (new BigNumber(endTime).isGreaterThan(lastStoreTime)) {
      break;
    }

    let s_k = new BigNumber(obj.cumulativeTick);
    let s_n;
    if (!cumulativeTickMap.get(endTime.toFixed())) {
      let bounds = getBounds(endTime, timeArr);
      // console.log(cumulativeTickMap.get(bounds.lowerBound.toFixed()));
      let targetDelta = new BigNumber(endTime).minus(bounds.lowerBound);
      let observationDelta = new BigNumber(bounds.upperBound).minus(
        bounds.lowerBound
      );

      s_n = new BigNumber(
        cumulativeTickMap.get(bounds.lowerBound.toFixed())
      ).plus(
        new BigNumber(
          new BigNumber(cumulativeTickMap.get(bounds.upperBound.toFixed()))
            .minus(cumulativeTickMap.get(bounds.lowerBound.toFixed()))
            .dividedBy(observationDelta)
        ).multipliedBy(targetDelta)
      );
    } else {
      s_n = new BigNumber(cumulativeTickMap.get(endTime.toFixed()));
    }

    let twap = new BigNumber(s_n.minus(s_k)).dividedBy(duration);
    priceArr.push(calculatePrice(twap));
    blocks.push(new BigNumber(obj.block).toString());
  }

  return { priceArr: priceArr, blocks: blocks };
}

async function getTwaps(duration) {
  let twapData = await processTwap();
  let tickArr = twapData.tickArr;
  let timeArr = [];
  let initialTick = twapData.initialTick;
  let initialTime = twapData.initialTime;

  let cumulativeTickArr = [];
  let cumulativeTickMap = new Map();
  cumulativeTickArr.push({
    cumulativeTick: new BigNumber(0),
    timeStamp: new BigNumber(tickArr[0].timeStamp),
    block: new BigNumber(tickArr[0].block),
  });
  cumulativeTickMap.set(tickArr[0].timeStamp, new BigNumber(0));
  timeArr.push(new BigNumber(tickArr[0].timeStamp));

  // cumulativeTicks_i = Tick_i-1(time_i - time_i-1)
  for (let i = 1; i < tickArr.length; i++) {
    let curTime = new BigNumber(tickArr[i].timeStamp);
    let interval = new BigNumber(curTime).minus(tickArr[i - 1].timeStamp);
    let prevCumulative = cumulativeTickArr.at(-1).cumulativeTick;
    let _cumulative = new BigNumber(tickArr[i - 1].tick)
      .multipliedBy(interval)
      .plus(prevCumulative);
    cumulativeTickArr.push({
      cumulativeTick: _cumulative,
      timeStamp: curTime,
      block: new BigNumber(tickArr[i].block),
    });
    cumulativeTickMap.set(curTime.toFixed(), _cumulative);
    timeArr.push(curTime);
  }

  let data = await cumulativeTickToTwap(
    cumulativeTickArr,
    cumulativeTickMap,
    duration,
    timeArr
  );

  let coords = {
    y: data.priceArr,
    x: data.blocks,
  };

  return coords;
}

function calculatePrice(twap) {
  let priceOfToken0InToken1 = Math.pow(1.0001, twap.toFixed()) / 10 ** 12;
  return 1 / priceOfToken0InToken1;
}

export default async function () {
  const width = 1024;
  const height = 800;

  const canvas = createCanvas(width, height);

  echarts.setPlatformAPI({
    //@ts-ignore
    createCanvas: () => canvas,
  });

  const { window } = new JSDOM();
  //@ts-ignore
  global.window = window;
  global.navigator = window.navigator;
  global.document = window.document;

  const root = document.createElement("div");
  root.style.cssText = `width: ${width}px; height: ${height}px;`;
  Object.defineProperty(root, "clientWidth", { value: width });
  Object.defineProperty(root, "clientHeight", { value: height });

  var chart = echarts.init(root, "dark", {
    renderer: "svg",
  });

  // Display the chart using the configuration items and data just specified.
  var plotData1 = await getTwaps(1800);
  var plotData2 = await getTwaps(3600);
  var plotData3 = await getTwaps(7200);
  chart.setOption({
    animation: false,
    color: ["#80FFA5", "#00DDFF", "#37A2FF", "#FF0087", "#FFBF00"],
    title: {
      text: "Twap vs Chainlink",
    },
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "cross",
        label: {
          backgroundColor: "#6a7985",
        },
      },
    },
    legend: {
      data: ["30 min", "60 min", "120 min"],
    },
    toolbox: {
      feature: {
        // saveAsImage: {}
      },
    },
    grid: {
      left: "3%",
      right: "4%",
      bottom: "3%",
      containLabel: true,
    },
    xAxis: [
      {
        type: "timestamp",
        boundaryGap: false,
        data: plotData1.x,
      },
    ],
    yAxis: [
      {
        type: "value",
      },
    ],
    series: [
      {
        name: "30min",
        type: "line",
        data: plotData1.y,
        encode: {
          x: "Timestamp",
          y: "Price",
          itemName: "Timestamp",
          tooltip: ["Price"],
        },
      },
      {
        name: "60min",
        type: "line",
        data: plotData2.y,
        encode: {
          x: "Timestamp",
          y: "Price",
          itemName: "Timestamp",
          tooltip: ["Price"],
        },
      },
      {
        name: "120min",
        type: "line",
        data: plotData3.y,
      },
    ],
    dataZoom: [
      {
        type: "inside",
        zoomOnMouseWheel: false,
        moveOnMouseWheel: true,
        xAxisIndex: 0,
        start: 30,
        end: 40,
      },
      {
        type: "slider",
        start: 30,
        end: 40,
      },
    ],
  });

  const data = root.querySelector("svg")!.outerHTML;

  chart.dispose();

  return data;
}
