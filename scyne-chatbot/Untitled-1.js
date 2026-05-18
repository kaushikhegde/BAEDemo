
// var logAPi = [];

// const app = express();
// const time = null;
// const endTime = null;

// const midll = (req, res, next) => {
//     let obj = {
//         method: req.method,
//         url: req.url,
//         id: req.ip
//     }
//     logAPi.push(obj);
//     time = new Date().getTime();
//     next();
// }

// app.use(midll);

// app.router.get('/some-api', (req, res) => res.status(200).json({message: abc}));

// app.use(midll_res);

// const midll_res = (req, res, next) => {
//     let obj = {
//         status: res.status,
//         message: res.message
//     }
//     logAPi.push(obj);
//     endTime = new Date().getTime();
//     next();
// }

// let timeTaken = endTime - time;



// let array = [1, [2, [3, [4, 2]], 1], 3, 5];

// let flat = [];



// let flatArray = (item) => {
//     if (Array.isArray(item)) {
//         item.forEach(flatArray);
//     } else {
//         flat.push(item);
//     }
// }

// // array.forEach(item => {
// //     if (Array.isArray(item)) {
// //         flatArray(item);
// //     } else {
// //         flat.push(item);
// //     }
// // })
// flatArray(array);

// console.log(Array.from(new Set(flat)));