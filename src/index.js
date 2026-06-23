require('dotenv').config();
const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const yaml = require('js-yaml');
const fs = require('fs');
const swaggerDocument = yaml.load(
  fs.readFileSync(require('path').join(__dirname, '../docs/api/openapi.yaml'), 'utf8')
);

const authRoutes = require('./routes/auth');
const cartRoutes = require('./routes/cart');
const productRoutes = require('./routes/product');
const orderRoutes = require('./routes/order');
const financialRoutes = require('./routes/financial');
const favoriteRoutes = require('./routes/favorite');
const documentRoutes = require('./routes/document');
const imageRoutes = require('./routes/image');
const customerRoutes = require('./routes/customer');
const posRoutes = require('./routes/pos');
const basketRoutes = require('./routes/basket');
const tigerRoutes = require('./routes/tiger');
const bizsuiteRoutes = require('./routes/bizsuite');
const salePrintRoutes = require('./routes/salePrint');
const purchaseRoutes = require('./routes/purchase');
const purchasePrintRoutes = require('./routes/purchasePrint');
const purchasePermiumRoutes = require('./routes/purchasePermium');
const promotionRoutes = require('./routes/promotion');
const salesReturnRoutes = require('./routes/salesReturn');
const advancePaymentRoutes = require('./routes/advancePayment');
const arBillingRoutes = require('./routes/arBilling');
const arDebtPaymentRoutes = require('./routes/arDebtPayment');
const otherExpenseRoutes = require('./routes/otherExpense');

const app = express();
const PORT = process.env.PORT || 47300;


app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'GUID',
    'configFileName',
    'databaseName',
    'Authorization',
    'Content-Type',
    'Accept',
    'Origin',
    'ngrok-skip-browser-warning',
  ],
}));

// Increase parser limits for base64 image uploads (e.g. saveProductImage).
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.text({ type: 'text/*', limit: '1mb' }));

// Routes — base path: /service/v1
app.use('/service/v1', authRoutes);
app.use('/service/v1', cartRoutes);
app.use('/service/v1', productRoutes);
app.use('/service/v1', orderRoutes);
app.use('/service/v1', financialRoutes);
app.use('/service/v1', favoriteRoutes);
app.use('/service/v1', documentRoutes);
app.use('/service/v1', imageRoutes);
app.use('/service/v1', customerRoutes);
app.use('/service/v1', posRoutes);
app.use('/service/v1', basketRoutes);
app.use('/service/v1', tigerRoutes);
app.use('/service/v1', bizsuiteRoutes);
app.use('/service/v1', salePrintRoutes);
app.use('/service/v1', purchaseRoutes);
app.use('/service/v1', purchasePrintRoutes);
app.use('/service/v1', purchasePermiumRoutes);
app.use('/service/v1', promotionRoutes);
app.use('/service/v1', salesReturnRoutes);
app.use('/service/v1', advancePaymentRoutes);
app.use('/service/v1', arBillingRoutes);
app.use('/service/v1', arDebtPaymentRoutes);
app.use('/service/v1', otherExpenseRoutes);

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`MarketPlaceWebService Express running on port ${PORT}`);
  console.log(`Base URL: http://localhost:${PORT}/service/v1/`);
});

module.exports = app;
