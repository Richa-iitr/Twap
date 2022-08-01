import { JSDOM } from "jsdom";
import * as echarts from "echarts"
import { createCanvas } from "@napi-rs/canvas"

export default function () {
    const canvas = createCanvas(500, 500);

    echarts.setPlatformAPI({
        //@ts-ignore
        createCanvas: () => canvas,
    });

    const { window } = new JSDOM();
    //@ts-ignore
    global.window = window;
    global.navigator = window.navigator;
    global.document = window.document;

    const root = document.createElement('div');
    root.style.cssText = 'width: 500px; height: 500px;';
    Object.defineProperty(root, "clientWidth", { value: 500 });
    Object.defineProperty(root, "clientHeight", { value: 500 });

    var chart = echarts.init(root, 'dark', {
        renderer: 'svg'
    });;

    // Display the chart using the configuration items and data just specified.
    chart.setOption({
        title: {
            text: 'ECharts Getting Started Example'
        },
        tooltip: {},
        legend: {
            data: ['sales']
        },
        xAxis: {
            data: ['Shirts', 'Cardigans', 'Chiffons', 'Pants', 'Heels', 'Socks']
        },
        yAxis: {},
        series: [
            {
                name: 'sales',
                type: 'bar',
                data: [5, 20, 36, 10, 10, 20]
            }
        ]
    });

    const data = root.querySelector('svg')!.outerHTML;

    chart.dispose()

    return data;
}