exports.name = 'Destination Backpressure Activated';
exports.type = 'metric';
exports.category = 'destinations';

let name;
let __workerGroup;
let timeWindow;
exports.init = (opts) => {
  const conf = opts.conf || {};
  ({
    name,
    __workerGroup,
    timeWindow
  } = conf);
  timeWindow = timeWindow || '60s';
};

exports.build = () => {
  let filter = `(_metric === 'blocked.outputs' && output === '${name}')`;
  let _raw = `'Backpressure is engaged for destination ${name}'`;
  const add = [
    { name: 'output', value: `'${name}'` },
    { name: '_metric', value: "'blocked.outputs'" },
  ];
  if (__workerGroup) {
    filter = `${filter} && __worker_group === '${__workerGroup}'`;
    _raw = `'Backpressure is engaged for destination ${name} in group ${__workerGroup}'`;
  }
  add.push({name: '_raw', value: _raw});

  return {
    filter,
    pipeline: {
      conf: {
        functions: [
          {
            id: 'aggregation',
            conf: {
              timeWindow,
              aggregations: [
                'perc(95, _value).as(blocked)'
              ],
              lagTolerance: '20s',
              idleTimeLimit: '20s',
            }
          },
          {
            id: 'drop',
            filter: 'Math.round(blocked) === 0',
            conf: {}
          },
          {
            id: 'eval',
            conf: {
              add
            }
          }
        ]
      }
    }
  };
};
