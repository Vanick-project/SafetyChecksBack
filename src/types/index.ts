import express from "express";
import userRoutes from "./routes/users";
import checkInRoutes from "./routes/checkins";
import alertRoutes from "./routes/alerts";
//import twimlRoutes from "./routes/twiml";
import twimlRouter from "./routes/twiml";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // required for Twilio callbacks

app.use("/users", userRoutes);
app.use("/checkins", checkInRoutes);
app.use("/alerts", alertRoutes);
//app.use("/twiml", twimlRoutes);
app.use("/twiml", twimlRouter);

app.listen(process.env.PORT ?? 3000, () => {
  console.log("Safety Check API running");
});

export default app;
