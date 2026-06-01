// 用接口描述一类对象的形状，类似 Go 的 struct 或 Python 的 TypedDict。
interface Developer {
    name: string;
    languages: string[];
    yearsOfExperience: number;
}

// 通过显式标注参数和返回值，让编辑器和编译器一起检查类型。
function introduce(dev: Developer): void {
    console.log(`Hi, I am ${dev.name}. I code in ${dev.languages.join(", ")}.`);
}

// 实例化一个符合 Developer 结构的对象；少字段或类型不匹配都会立刻报错。
const me: Developer = {
    name: "TS Beginner",
    languages: ["Go", "Python", "TypeScript"],
    yearsOfExperience: 3
};

introduce(me);