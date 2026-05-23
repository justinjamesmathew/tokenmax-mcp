import { Router, type Request, type Response } from "express";

export type UserId = string;

export interface User {
  id: UserId;
  name: string;
}

const users = new Map<UserId, User>();

export const usersRouter: Router = Router();

usersRouter.get("/", (_req: Request, res: Response) => {
  res.json([...users.values()]);
});

usersRouter.post("/", (req: Request, res: Response) => {
  const u = req.body as User;
  users.set(u.id, u);
  res.status(201).json(u);
});

export class UserService {
  list(): User[] {
    return [...users.values()];
  }

  get(id: UserId): User | undefined {
    return users.get(id);
  }
}
