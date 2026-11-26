import authRouter from "./auth-routes.js";
import invitationRouter from "./invitation-routes.js";
import propertyRouter from "./property-routes.js";
import rentRouter from "./rent-routes.js";
import complaintRouter from "./complaint-routes.js";
import announcementRouter from "./announcement-routes.js";
import expenseRouter from "./expense-routes.js";
import notificationRouter from "./notification-routes.js";
import paymentRouter from "./payment-routes.js";

export function registerRoutes(app) {
  app.use(authRouter);
  app.use(invitationRouter);
  app.use(propertyRouter);
  app.use(rentRouter);
  app.use(complaintRouter);
  app.use(announcementRouter);
  app.use(expenseRouter);
  app.use(notificationRouter);
  app.use(paymentRouter);
}
