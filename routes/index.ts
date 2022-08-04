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

    if (tick !== prevTick) {
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
      timeStamp: new BigNumber(_time),
      tick: new BigNumber(_data.tick),
      block: new BigNumber(blockMap.get(_time)),
    });
  });
  // console.log(tickArr);
  tickArr = tickArr.sort((a, b) => (a.timeStamp.gt(b.timeStamp) ? 1 : -1));
  return {
    tickArr: tickArr,
    initialTime: initialTime,
    initialTick: initialTick,
  };
}

function getBounds(timestamp, timeArr) {
  const allLower = timeArr.filter((x) =>
    new BigNumber(x).isLessThan(timestamp)
  );
  const allUpper = timeArr.filter((x) =>
    new BigNumber(x).isGreaterThan(timestamp)
  );
  console.log(allLower);

  const lowerBound = BigNumber.maximum(...allLower);
  const upperBound = BigNumber.minimum(...allUpper);

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
  let times = [];
  let lastStoreTime = cumulativeTickArr[cumulativeTickArr.length - 1].timeStamp;

  for (let obj of cumulativeTickArr) {
    let endTime = new BigNumber(obj.timeStamp).plus(duration);
    if (new BigNumber(endTime).isGreaterThan(lastStoreTime)) {
      break;
    }

    let s_k = new BigNumber(obj.cumulativeTick);
    let s_n;
    if (!cumulativeTickMap.get(endTime)) {
      let bounds = getBounds(endTime, timeArr);
      let targetDelta = new BigNumber(endTime).minus(bounds.lowerBound);
      let observationDelta = new BigNumber(bounds.upperBound).minus(
        bounds.lowerBound
      );

      s_n = new BigNumber(cumulativeTickMap.get(bounds.lowerBound)).plus(
        new BigNumber(
          new BigNumber(cumulativeTickMap.get(bounds.upperBound))
            .minus(cumulativeTickMap.get(bounds.lowerBound))
            .dividedBy(observationDelta)
        ).multipliedBy(targetDelta)
      );
    } else {
      s_n = new BigNumber(cumulativeTickMap.get(endTime));
    }

    let twap = new BigNumber(s_n.minus(s_k)).dividedBy(duration);
    twapArr.push(twap);
    priceArr.push(calculatePrice(twap));
    times.push(new BigNumber(obj.timeStamp).toString());
  }
  console.log(twapArr);
  return { priceArr: priceArr, times: times };
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
  });
  cumulativeTickMap.set(new BigNumber(tickArr[0].timeStamp), new BigNumber(0));
  timeArr.push(new BigNumber(tickArr[0].timeStamp));

  // cumulativeTicks_i = Tick_i-1(time_i - time_i-1)
  for (let i = 1; i < tickArr.length; i++) {
    let curTime = new BigNumber(tickArr[i].timeStamp);
    let interval = new BigNumber(curTime).minus(tickArr[i - 1].timeStamp);
    let prevCumulative = new BigNumber(cumulativeTickArr.at(-1));
    let _cumulative = new BigNumber(tickArr[i - 1].tick)
      .multipliedBy(interval)
      .plus(prevCumulative);
    cumulativeTickArr.push({ cumulativeTick: _cumulative, timeStamp: curTime });
    cumulativeTickMap.set(curTime, _cumulative);
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
    x: data.times,
  };

  return coords;
}

function calculatePrice(twap) {
  return Math.pow(1.0001, twap);
}

export default async function () {
  const width = 1024;
  const height = 600;

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
  var plotData1 = await getTwaps(300);
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
      data: ["5 min"],
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
        name: "5 min",
        type: "line",
        stack: "Total",
        smooth: true,
        lineStyle: {
          width: 0,
        },
        showSymbol: false,
        areaStyle: {
          opacity: 0.8,
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            {
              offset: 0,
              color: "rgb(128, 255, 165)",
            },
            {
              offset: 1,
              color: "rgb(1, 191, 236)",
            },
          ]),
        },
        emphasis: {
          focus: "series",
        },
        data: [1,2,2,3],
      },
      // {
      //     name: 'Line 2',
      //     type: 'line',
      //     stack: 'Total',
      //     smooth: true,
      //     lineStyle: {
      //         width: 0
      //     },
      //     showSymbol: false,
      //     areaStyle: {
      //         opacity: 0.8,
      //         color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
      //             {
      //                 offset: 0,
      //                 color: 'rgb(0, 221, 255)'
      //             },
      //             {
      //                 offset: 1,
      //                 color: 'rgb(77, 119, 255)'
      //             }
      //         ])
      //     },
      //     emphasis: {
      //         focus: 'series'
      //     },
      //     data: [120, 282, 111, 234, 220, 340, 310]
      // },
      // {
      //     name: 'Line 3',
      //     type: 'line',
      //     stack: 'Total',
      //     smooth: true,
      //     lineStyle: {
      //         width: 0
      //     },
      //     showSymbol: false,
      //     areaStyle: {
      //         opacity: 0.8,
      //         color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
      //             {
      //                 offset: 0,
      //                 color: 'rgb(55, 162, 255)'
      //             },
      //             {
      //                 offset: 1,
      //                 color: 'rgb(116, 21, 219)'
      //             }
      //         ])
      //     },
      //     emphasis: {
      //         focus: 'series'
      //     },
      //     data: [320, 132, 201, 334, 190, 130, 220]
      // },
      // {
      //     name: 'Line 4',
      //     type: 'line',
      //     stack: 'Total',
      //     smooth: true,
      //     lineStyle: {
      //         width: 0
      //     },
      //     showSymbol: false,
      //     areaStyle: {
      //         opacity: 0.8,
      //         color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
      //             {
      //                 offset: 0,
      //                 color: 'rgb(255, 0, 135)'
      //             },
      //             {
      //                 offset: 1,
      //                 color: 'rgb(135, 0, 157)'
      //             }
      //         ])
      //     },
      //     emphasis: {
      //         focus: 'series'
      //     },
      //     data: [220, 402, 231, 134, 190, 230, 120]
      // },
      // {
      //     name: 'Line 5',
      //     type: 'line',
      //     stack: 'Total',
      //     smooth: true,
      //     lineStyle: {
      //         width: 0
      //     },
      //     showSymbol: false,
      //     label: {
      //         show: true,
      //         position: 'top'
      //     },
      //     areaStyle: {
      //         opacity: 0.8,
      //         color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
      //             {
      //                 offset: 0,
      //                 color: 'rgb(255, 191, 0)'
      //             },
      //             {
      //                 offset: 1,
      //                 color: 'rgb(224, 62, 76)'
      //             }
      //         ])
      //     },
      //     emphasis: {
      //         focus: 'series'
      //     },
      //     data: [220, 302, 181, 234, 210, 290, 150]
      // }
    ],
  });

  const data = root.querySelector("svg")!.outerHTML;

  chart.dispose();

  return data;
}
