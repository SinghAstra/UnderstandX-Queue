import prisma from "../db/prisma.js";

export const getAllUsers = async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({});
    res.status(200).json({
      status: "success",
      data: users,
    });
  } catch (error) {
    console.log("Error in getAllUsers");
    if (error instanceof Error) {
      console.log("Error message is ", error.message);
      console.log("Error stack is ", error.stack);
    }
    return res.status(500).json({ message: "Server Error" });
  }
};
