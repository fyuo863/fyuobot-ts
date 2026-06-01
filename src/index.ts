// 这非常像 Go 里的 struct，或者 Python 里的 TypedDict
interface Developer {
    name: string;
    languages: string[];
    yearsOfExperience: number;
}

// 明确参数类型和返回值类型（如果没有返回值，可以使用 void）
function introduce(dev: Developer): void {
    console.log(`Hi, I am ${dev.name}. I code in ${dev.languages.join(", ")}.`);
}

// 实例化数据。如果你在这里漏掉字段或写错类型，编辑器会像 Go 编译器一样立刻报错
const me: Developer = {
    name: "TS Beginner",
    languages: ["Go", "Python", "TypeScript"],
    yearsOfExperience: 3
};

introduce(me);