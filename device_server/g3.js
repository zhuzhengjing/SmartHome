/**
 * Created by missionhealth on 15/11/10.
 */

var net = require('net');
var tcp_server_port = require('../settings.js');

// 树莓派只有一个串口,默认被用来做console了,需要先禁用
var SERIAL_PORT = '/dev/ttyAMA0';
// G3的数据包长度为24字节
var PACKAGE_LEN = 24;

// serial
var SerialPort = require("serialport").SerialPort;
// RPI PWM
var wpi = require('wiring-pi');

// ---- GPIO ----
wpi.setup('wpi');

// GPIO1: PWM
var GPIO_PWM = 1;
wpi.pinMode(GPIO_PWM, wpi.PWM_OUTPUT);
wpi.pwmWrite(GPIO_PWM, 0);

// GPIO_PM2_5: 控制PM2.5传感器打开关闭，1-打开，0-关闭
var GPIO_PM2_5 = 4;
wpi.pinMode(GPIO_PM2_5, wpi.OUTPUT);

// ---- Serial ----
var serialPort = new SerialPort(SERIAL_PORT, {
    baudrate: 9600
});

// 为了数据处理统一,直接连接本地TCP server
var client;

var serial_package_index = 0;
var serial_package_array = [];

// 每次读取15个点,前面10个丢弃,后面5个计算平均值并保存到数据库.然后休眠2分钟
var handle_real_pm25 = function(data_package) {
    serial_package_index++;

    if (serial_package_index == 10) {
        // 接收数据之前清空之前的数据
        serial_package_array.length = 0;
        serial_package_array.push(data_package);
    } else if (serial_package_index > 10 && serial_package_index < 15) {
        serial_package_array.push(data_package);
    } else if (serial_package_index == 15) {
        serial_package_array.push(data_package);
        serial_package_index = 0;
        // 关闭PM2.5传感器
        wpi.digitalWrite(GPIO_PM2_5, 0);
        // 计算平均值然后保存数据
        var pm1_0_average = 0, pm2_5_average = 0, pm10_average = 0;
        for (var data in serial_package_array) {
            pm1_0_average += data.pm_air_10;
            pm2_5_average += data.pm_air_2_5;
            pm10_average += data.pm_air_10;
        }

        pm1_0_average = pm1_0_average / serial_package_array.length;
        pm2_5_average = pm2_5_average / serial_package_array.length;
        pm10_average = pm10_average / serial_package_array.length;

        var data_save = {
            name: "RPi PM2.5 Sensor",
            device_id: "G3-RPi-1100000",
            sensor: [
                {
                    type: 3,
                    value: {
                        pm1_0: pm1_0_average,
                        pm2_5: pm2_5_average,
                        pm10: pm10_average
                    }
                }
            ]
        };

        client.write(JSON.stringify(data_save));

        // 2分钟后再进行下一轮测试
        setTimeout(function () {
            // 打开PM2.5传感器
            wpi.digitalWrite(GPIO_PM2_5, 1);
        }, 2*60*1000);
    }
};

var g3 = function() {
    serialPort.on("open", function () {
        console.log(SERIAL_PORT + ' open success');

        // 高电平打开G3传感器
        wpi.digitalWrite(GPIO_PM2_5, 1);

        // 连接TCP服务器
        client_function();

        // 处理完整的package
        var handle_package = function(data_package) {
            console.log('#####################');
            console.log(data_package);
            // data length should be 24bytes
            if (data_package.length !== 24) {
                console.log('data package length[24, %d]', package.length);
                return;
            }

            // check data package length, should be 20
            var package_length = data_package[2] * 256 + data_package[3];
            if (package_length !== 20) {
                console.log('RECV data package length error[20, %d]', package_length);
                return;
            }

            // check CRC
            var crc = 0;
            for (var i = 0; i < data_package.length - 2; i++) {
                crc += data_package[i];
            }
            crc = crc % (256*256);
            var package_crc = data_package[22] * 256 + data_package[23];
            if (package_crc !== crc) {
                console.log('data package crc error[%d, %d]', package_crc, crc);
                return;
            }

            // all is OK, let's get real value
            var index = 4;
            if (data_package[0] === 0x42 && data_package[1] === 0x4d) {
                // PM1.0(CF=1)
                var pm1_0 = data_package[index++] * 256 + data_package[index++];
                // PM2.5(CF=1)
                var pm2_5 = data_package[index++] * 256 + data_package[index++];
                // PM10(CF=1)
                var pm10 = data_package[index++] * 256 + data_package[index++];

                console.log('(CF=1) -> [%d, %d, %d]', pm1_0, pm2_5, pm10);

                // PM1.0(大气环境下)
                var pm_air_1_0 = data_package[index++] * 256 + data_package[index++];
                // PM2.5(大气环境下)
                var pm_air_2_5 = data_package[index++] * 256 + data_package[index++];
                // PM10(大气环境下)
                var pm_air_10 = data_package[index++] * 256 + data_package[index++];

                console.log('大气环境 -> [%d, %d, %d]', pm_air_1_0, pm_air_2_5, pm_air_10);
                handle_real_pm25({
                    pm_air_1_0: pm_air_1_0,
                    pm_air_2_5: pm_air_2_5,
                    pm_air_10: pm_air_10
                });

                // 数据7,8,9保留
            } else {
                console.log('RECV data err: ');
                console.log(data_package);
            }
        };

        var whole_package = new Buffer(PACKAGE_LEN);
        var package_index = 0;
        serialPort.on('data', function(data) {
            // test
            console.log(data);

            for (var i = 0; i < data.length; i++) {
                // check package header
                if (package_index === 0) {
                    if (data[i] === 0x42 && data[i + 1] === 0x4d) {
                        whole_package[package_index++] = data[i];
                    }
                } else if (package_index < PACKAGE_LEN){
                    whole_package[package_index++] = data[i];
                }

                if (package_index === PACKAGE_LEN) {
                    handle_package(whole_package);
                    package_index = 0;
                }
            }
        });
    });

    serialPort.on('error', function(err) {
        console.log('Open serial port error: ' + err);
    });
};

var client_function = function() {
    client = net.connect({port: tcp_server_port.server_listen_port}, function() { //'connect' listener
        console.log('G3: connected to server!');
    });

    client.on('data', function(data) {
        console.log(data.toString());
    });

    client.on('end', function() {
        console.log('G3: disconnected from server');
    });
};

module.exports = g3;
