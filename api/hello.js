module.exports = (req, res) => {
  res.json({ hello: "world", env: process.env.NODE_ENV });
};
